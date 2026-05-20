#!/bin/sh
# Write the per-app nginx vhost config.
#
# Runs inside the nginx LXC. Adopts the production/setup-nginx.sh pattern:
# SSL terminates on port 1443 with the addon-ssl cert bundle, SPA served
# from /usr/share/nginx/html/<slug>/ with try_files fallback for client-side
# routing, /api/ reverse-proxies to postgrest:3000.
#
# Template variables:
#   app_slug        - vhost filename + html subdir
#   app_subdomain   - server_name
#   POSTGREST_HOST  - resolved from app_dependencies (185-host-resolve-dependency-hosts)

set -eu

APP_SLUG="{{ app_slug }}"
APP_SUBDOMAIN="{{ app_subdomain }}"
POSTGREST_HOST="{{ POSTGREST_HOST }}"

if [ -z "$APP_SLUG" ] || [ "$APP_SLUG" = "NOT_DEFINED" ]; then
  echo "ERROR: app_slug is required" >&2; exit 1
fi
if [ -z "$APP_SUBDOMAIN" ] || [ "$APP_SUBDOMAIN" = "NOT_DEFINED" ]; then
  echo "ERROR: app_subdomain is required" >&2; exit 1
fi
case "$POSTGREST_HOST" in ""|NOT_DEFINED) POSTGREST_HOST="postgrest" ;; esac

CONF_DIR="/etc/nginx/conf.d"
TARGET="$CONF_DIR/${APP_SLUG}.conf"

cat > "$TARGET" <<EOF
server {
    listen 1443 ssl;
    listen [::]:1443 ssl;
    server_name ${APP_SUBDOMAIN};

    ssl_certificate     /etc/ssl/addon/fullchain.pem;
    ssl_certificate_key /etc/ssl/addon/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    root /usr/share/nginx/html/${APP_SLUG};
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://${POSTGREST_HOST}:3000/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Authorization \$http_authorization;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

echo "write-nginx-vhost: wrote $TARGET" >&2

if command -v nginx >/dev/null 2>&1; then
  if ! nginx -t 2>&1 | tail -5 >&2; then
    echo "ERROR: nginx -t failed for $TARGET" >&2
    exit 1
  fi
fi

cat <<EOF
[
  {"id": "vhost_path", "value": "$TARGET"}
]
EOF
