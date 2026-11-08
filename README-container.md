# Code - OSS web IDE and Agents Window container

Self-hosted container image built from upstream `microsoft/vscode` at tag
`1.145.2` (commit `c4453f8ea430795f941c1b2ff6c9321135a74a02`) with no source
patches. The image serves two pages from the same build artifact:

- `/` - the full Code - OSS web workbench (`vs/workbench/workbench.web.main.internal`)
- `/agents` - the Agents Window (`vs/sessions/sessions.web.main.internal`)

Only new files are added to the upstream tree. Vendored source under `src/`,
`build/`, `extensions/`, `product.json`, and all TypeScript/JavaScript remains
byte-identical to the tag.

## Files added

- `.github/workflows/container.yml` - builds the web artifact and pushes the image
- `docker/Dockerfile` - `nginx:alpine` runtime image, no compilation in the image
- `docker/nginx.conf.template` - MIME types, gzip, caching, `/healthz`, `/agents`
- `docker/index.html` - workbench shell (authored, because the `web` build emits no HTML)
- `docker/agents.html` - Agents Window shell
- `docker/config.json` - default (empty) remote agent host configuration
- `README-container.md` - this file

## Image

```
ghcr.io/vanduc2514/vscode:1.145.2
ghcr.io/vanduc2514/vscode:latest
ghcr.io/vanduc2514/vscode:c4453f8ea430795f941c1b2ff6c9321135a74a02
```

The tag is a multi-architecture manifest for `linux/amd64` and `linux/arm64`.
The GHCR package is public; no `docker login` is required. On a client that
cannot consume the arm64 entry (for example an older x86 Docker without
emulation), pull explicitly with `--platform linux/amd64`.

## Run

```bash
docker run --rm -d --name agents-ui -p 8099:80 \
  ghcr.io/vanduc2514/vscode:1.145.2
```

Open `http://localhost:8099/` for the IDE and
`http://localhost:8099/agents` for the Agents Window.

The agent host is dialled by the **browser**, not by the container: the
workbench and its extension host run in the page. Configure a `remoteAgentHosts`
`address` the browser can reach, for example `ws://localhost:3011` when the
browser runs on the same machine as the host. A remote browser needs that port
published, or its own proxy.

Health check:

```bash
curl -fsS http://localhost:8099/healthz
```

## Shell bootstrap

The `web` artifact contains `out/nls.messages.js`, which installs the
`_VSCODE_NLS_MESSAGES` table. Both shells load it as a classic script before the
module; without it the workbench aborts with `NLS MISSING`.

The shells also set `globalThis._VSCODE_FILE_ROOT` to `<base>/out/` in a classic
script before the module graph evaluates. The bundle calls `asFileUri()` for
icons while its top-level code runs, so setting this inside the module body is
too late and produces `Cannot determine URI for module id!`.

Both scripts are authored files; no upstream source is patched.

## Remote agent hosts (AHP over WebSocket)

Both pages fetch `/config.json` at boot (no rebuild needed) and pass the entries
to the `chat.remoteAgentHosts` setting. `chat.remoteAgentHostsEnabled` is always
`true`. The expected shape is an object with a `remoteAgentHosts` array, or a
top-level array:

```json
{
  "remoteAgentHosts": [
    {
      "name": "my-agent-host",
      "address": "wss://agent-host.example.com/ahp",
      "connectionToken": "optional-token"
    }
  ]
}
```

Mount a file over the default one:

```bash
docker run --rm -d --name agents-ui -p 8099:80 \
  -v "$PWD/config.json:/usr/share/nginx/html/config.json:ro" \
  ghcr.io/vanduc2514/vscode:1.145.2
```

If `config.json` is absent or unreadable, the pages fall back to an empty list.
A configured host appears in the Agents Window sidebar by name.

## Agents signed-out mode

`docker/agents.html` sets the upstream `skip-sessions-welcome` query flag before
the workbench starts. This opens `/agents` directly in the signed-out Agents
Window, which is what a self-hosted deployment with AHP hosts needs; the default
GitHub sign-in gate otherwise covers the window with a non-dismissible dialog.
The flag is the same one the upstream sessions code uses for smoke tests.
Remove the small script block in `agents.html` if you want the sign-in gate
back.

## BYOK models (bring your own key)

`docker/extensions/byok-openai` is an authored web extension that registers
OpenAI-compatible chat models with the stable
`vscode.lm.registerLanguageModelChatProvider` API. Models and credentials come
from `/config.json`, never from the image or the HTML:

```json
{
  "remoteAgentHosts": [],
  "byok": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiType": "chat-completions",
    "apiKey": "sk-...",
    "models": [
      { "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" },
      { "id": "deepseek-flash", "name": "DeepSeek Flash" }
    ]
  }
}
```

`apiType` accepts `chat-completions` (default) or `messages` (Anthropic style).
`baseUrl` is the OpenAI-compatible base URL, for example
`https://api.deepseek.com/v1`; the extension appends `/chat/completions` (or
`/messages`). Calls go straight from the browser to that origin, so it must
send CORS headers; DeepSeek does.

```bash
docker run --rm -d --name agents-ui -p 8099:80 \
  -v "$PWD/config.json:/usr/share/nginx/html/config.json:ro" \
  ghcr.io/vanduc2514/vscode:1.145.2
```

The BYOK extension also sets `github.copilot.clientByokEnabled`,
`github.copilot.hasByokModels` and `chatNonCopilotModelsAreUserSelectable`, and
re-asserts them for two minutes, because the workbench re-derives
`hasByokModels` from the Copilot extension that this image does not ship.

Status of each surface:

- Editor at `/` - works. The model picker lists the configured models while
  signed out and preselects one.
- Agents Window at `/agents` - the sign-in placeholder is gone (the model
  control reads `Models, Auto`), but the composer's list is host-owned: an
  agent-host session only accepts models the host advertises for that session,
  and the host wires BYOK models at session launch. A provider that registers
  models through the public API cannot declare `targetChatSessionType`, so it
  cannot populate that list before a session exists.

## Signed-out sessions (no GitHub login)

`copilotcli` is a Copilot-backed harness, so the Agents Window normally refuses
to start a session while the renderer is signed out:

```
Sign in to use GitHub Copilot
Authentication is required to start a session. Please sign in and try again.
```

The host's own Copilot credentials are irrelevant to that check — it runs in the
browser and looks at the renderer's GitHub account only.

Both shells therefore set:

```json
"chat.allowAnonymousAccess": true
```

With `entitlement === Unknown` and anonymous enabled, the `SignInRequired`
branch in `getSessionTypeAvailability` is skipped, and `copilotcli` resolves to
available through its Auto fallback. The same setting can be toggled per browser
in Settings ("Chat: Allow Anonymous Access") without a rebuild.

## Build

The workflow runs on `ubuntu-22.04` with Node from `.nvmrc`. It mirrors the
upstream web pipeline:

```bash
npm ci
npm run gulp core-ci
npm run gulp vscode-web-min-ci
```

Ubuntu 22.04 ships GCC 11.4, which cannot parse the Electron 43 V8 headers
when `USING_V8_SHARED` and the V8 deprecation-warning macros are both defined.
For `npm ci` only, the workflow sets `CFLAGS` and `CXXFLAGS` to undefine
`V8_DEPRECATION_WARNINGS` and `V8_IMMINENT_DEPRECATION_WARNINGS`. This only
silences deprecated-API warnings during native module builds and changes no
upstream file.

`vscode-web-min-ci` writes the artifact to `../vscode-web` relative to the
repository root. The workflow moves it into the workspace, caches it under
`vscode-web-<tag>-<commit>-v1`, verifies these files exist, and prints their
sizes before building the image:

- `out/vs/workbench/workbench.web.main.internal.js` and `.css`
- `out/vs/sessions/sessions.web.main.internal.js` and `.css`
- `extensions/theme-defaults/package.json`
- `extensions/theme-seti/package.json`

The `web` build emits JavaScript and CSS only. Microsoft's public pages supply
their own HTML shells, so this repository authors `docker/index.html` and
`docker/agents.html`. The workbench CSS is linked directly as
`out/vs/workbench/workbench.web.main.internal.css` (the same mechanism the live
vscode.dev page uses); no CSS import map is required because the bundles do not
import CSS modules.

The image is built for `linux/amd64` and `linux/arm64` with QEMU and exported as
one multi-architecture manifest.

`additionalBuiltinExtensions` points at `extensions/theme-defaults` and
`extensions/theme-seti` so the workbench is themed at first paint.

## Branding and services

- `nameShort`/`nameLong` are `Code - OSS`; the Agents page uses
  `Code - OSS Agents`.
- `enableTelemetry: false` and `telemetry.telemetryLevel: off`.
- No Microsoft marketplace, CDN, or vscode.dev URL appears in the served HTML.
  The extension gallery, if used, is Open VSX.
- `LICENSE.txt` and `ThirdPartyNotices.txt` are copied into the image for MIT
  attribution.

## Limitations

- The workbench starts with an empty workspace. The container does not
  implement a local folder picker or a remote workspace provider; the Agents
  Window is expected to connect to remote agent hosts over WebSocket.
- Webview content is served same-origin from
  `out/vs/workbench/contrib/webview/browser/pre/` instead of a separate
  origin. This is intentional for a single-hostname deployment and is less
  isolated than Microsoft's per-webview subdomain approach.
- The image contains the upstream build output, including upstream source map
  references in the bundles; no upstream file is modified.
