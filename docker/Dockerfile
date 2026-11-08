# syntax=docker/dockerfile:1
FROM nginx:alpine

# Build output produced by vscode-web-min-ci (out/, extensions/, node_modules/,
# package.json, manifest.json, favicon.ico, code-192.png, code-512.png).
COPY vscode-web/ /usr/share/nginx/html/

# Authored shells and runtime configuration.
COPY docker/index.html /usr/share/nginx/html/index.html
COPY docker/agents.html /usr/share/nginx/html/agents.html
COPY docker/config.json /usr/share/nginx/html/config.json

# BYOK provider extension: registers OpenAI-compatible models from /config.json.
COPY docker/extensions/byok-openai /usr/share/nginx/html/extensions/byok-openai

# MIT attribution is required for redistribution.
COPY LICENSE.txt /usr/share/nginx/html/LICENSE.txt
COPY ThirdPartyNotices.txt /usr/share/nginx/html/ThirdPartyNotices.txt

# Processed by /docker-entrypoint.d/20-envsubst-on-templates.sh at startup.
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template

# Same-origin OpenAI-compatible endpoint for the BYOK provider extension.
# Point this at an HTTP(S) origin, for example http://host.docker.internal:4000.
# The request path after /llm/ is forwarded unchanged, so /llm/v1/chat/completions
# becomes <upstream>/v1/chat/completions. The default is a closed port so /llm/
# returns 502 until it is configured.
ENV LLM_UPSTREAM=http://127.0.0.1:9

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1
