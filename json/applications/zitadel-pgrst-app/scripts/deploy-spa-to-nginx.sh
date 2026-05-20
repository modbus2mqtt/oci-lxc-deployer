#!/bin/sh
# Deploy SPA assets from the uploaded tgz into the nginx html volume.
#
# Runs inside the nginx LXC (execute_on: application:nginx). Extracts only
# the tgz's web/* tree, strips the leading "web/" component, and chowns to
# nginx-unprivileged's uid (101). Requires nginx to be deployed with the
# `html=/usr/share/nginx/html` volume — see production/nginx.json.
#
# Template variables:
#   app_slug         - URL path component / target subdirectory
#   app_tgz_content  - Base64 tgz from pack-for-proxvex.sh

set -eu

APP_SLUG="{{ app_slug }}"
TGZ_B64="{{ app_tgz_content }}"

if [ -z "$APP_SLUG" ] || [ "$APP_SLUG" = "NOT_DEFINED" ]; then
  echo "ERROR: app_slug is required" >&2
  exit 1
fi
if [ -z "$TGZ_B64" ] || [ "$TGZ_B64" = "NOT_DEFINED" ]; then
  echo "ERROR: app_tgz_content is required" >&2
  exit 1
fi

HTML_ROOT="/usr/share/nginx/html"
if [ ! -d "$HTML_ROOT" ]; then
  echo "ERROR: $HTML_ROOT does not exist. Install the nginx application with volumes='conf=/etc/nginx/conf.d\\nhtml=/usr/share/nginx/html' (see production/nginx.json)." >&2
  exit 1
fi

TARGET="$HTML_ROOT/$APP_SLUG"
NEW="$TARGET.new"
rm -rf "$NEW"
mkdir -p "$NEW"

echo "deploy-spa-to-nginx: extracting web/* to $NEW" >&2
printf '%s' "$TGZ_B64" | base64 -d | tar -xzf - -C "$NEW" --strip-components=1 web || {
  echo "ERROR: failed to extract web/ from tgz" >&2
  rm -rf "$NEW"
  exit 1
}

# Atomic swap so half-deployed state is never visible.
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET.old"
  mv "$TARGET" "$TARGET.old"
fi
mv "$NEW" "$TARGET"
rm -rf "$TARGET.old"

chown -R 101:101 "$TARGET" 2>/dev/null || true
echo "deploy-spa-to-nginx: deployed $(find "$TARGET" -type f | wc -l) files to $TARGET" >&2

cat <<EOF
[
  {"id": "web_target_path", "value": "$TARGET"}
]
EOF
