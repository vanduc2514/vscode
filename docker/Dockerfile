# syntax=docker/dockerfile:1
FROM nginx:alpine

# Build output produced by vscode-web-min-ci (out/, extensions/, node_modules/,
# package.json, manifest.json, favicon.ico, code-192.png, code-512.png).
COPY vscode-web/ /usr/share/nginx/html/

# Authored shells and runtime configuration.
COPY docker/index.html /usr/share/nginx/html/index.html
COPY docker/agents.html /usr/share/nginx/html/agents.html
COPY docker/config.json /usr/share/nginx/html/config.json

# MIT attribution is required for redistribution.
COPY LICENSE.txt /usr/share/nginx/html/LICENSE.txt
COPY ThirdPartyNotices.txt /usr/share/nginx/html/ThirdPartyNotices.txt

# Processed by /docker-entrypoint.d/20-envsubst-on-templates.sh at startup.
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template

# Same-origin WebSocket reverse proxy target for /ahp. Point this at an HTTP(S)
# origin such as http://agent-host:8080; the container never terminates TLS for
# the upstream, so use https:// for a TLS upstream. The default is a closed port
# so /ahp returns 502 until it is configured.
ENV AHP_UPSTREAM=http://127.0.0.1:9

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1
