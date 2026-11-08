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
- `docker/nginx.conf.template` - MIME types, gzip, caching, `/healthz`, `/agents`, `/ahp`
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

## Remote agent hosts (AHP)

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

### Same-origin WebSocket proxy

`/ahp` is proxied by nginx so a WebSocket agent host can be same-origin. Set
`AHP_UPSTREAM` to an HTTP(S) origin; nginx handles the `Upgrade` and
`Connection` headers and disables buffering:

```bash
docker run --rm -d --name agents-ui -p 8099:80 \
  -e AHP_UPSTREAM=http://agent-host:8080 \
  ghcr.io/vanduc2514/vscode:1.145.2
```

Then configure an agent host address such as `ws://localhost:8099/ahp`. The
upstream value is an HTTP(S) URL, not a `ws://` URL. The default
`http://127.0.0.1:9` intentionally points at a closed port so `/ahp` returns
502 until it is configured.

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
