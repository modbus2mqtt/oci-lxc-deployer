#!/bin/sh
# Configure lighttpd to enable FastCGI and set HTTP port (runs inside the container)
# Inputs (templated):
#   {{ http_port }}  - HTTP port number
set -eu

HTTP_PORT="{{ http_port }}"
LIGHTTPD_CONF="/etc/lighttpd/lighttpd.conf"
LIGHTTPD_DIR="/etc/lighttpd"

# Ensure lighttpd configuration directory exists
mkdir -p "$LIGHTTPD_DIR" >&2

# Create required directories for lighttpd
mkdir -p /var/cache/lighttpd/uploads /var/cache/lighttpd/compress /var/log/lighttpd /var/www/localhost/htdocs >&2
chown -R lighttpd:lighttpd /var/cache/lighttpd /var/log/lighttpd /var/www/localhost/htdocs >&2

# Create default configuration if it doesn't exist
if [ ! -f "$LIGHTTPD_CONF" ]; then
  echo "Creating default lighttpd configuration..." >&2
  cat > "$LIGHTTPD_CONF" << 'EOF'
server.modules = (
    "mod_access",
    "mod_alias",
    "mod_compress",
    "mod_redirect",
    "mod_rewrite"
)

server.document-root        = "/var/www/localhost/htdocs"
server.upload-dirs          = ( "/var/cache/lighttpd/uploads" )
server.errorlog             = "/var/log/lighttpd/error.log"
server.pid-file             = "/var/run/lighttpd.pid"
server.username             = "lighttpd"
server.groupname            = "lighttpd"
server.port                 = 80

index-file.names            = ( "index.php", "index.html", "index.lighttpd.html" )
url.access-deny             = ( "~", ".inc" )
static-file.exclude-extensions = ( ".php", ".pl", ".fcgi" )

compress.cache-dir          = "/var/cache/lighttpd/compress/"
compress.filetype           = ( "application/javascript", "text/css", "text/html", "text/plain" )

include_shell "/usr/share/lighttpd/create-mime.conf.pl"
EOF
  echo "Default configuration created." >&2
fi

# Configure server port
if grep -q "^server.port" "$LIGHTTPD_CONF"; then
  # Update existing server.port
  sed -i "s|^server.port.*|server.port = ${HTTP_PORT}|" "$LIGHTTPD_CONF"
elif grep -q "^#.*server.port" "$LIGHTTPD_CONF"; then
  # Uncomment and update server.port
  sed -i "s|^#.*server.port.*|server.port = ${HTTP_PORT}|" "$LIGHTTPD_CONF"
else
  # Add server.port if it doesn't exist (add after server.modules or at the beginning)
  if grep -q "^server.modules" "$LIGHTTPD_CONF"; then
    # Add after server.modules block
    sed -i "/^server.modules =/a server.port = ${HTTP_PORT}" "$LIGHTTPD_CONF"
  else
    # Add at the beginning of the file
    sed -i "1i server.port = ${HTTP_PORT}" "$LIGHTTPD_CONF"
  fi
fi

# Uncomment mod_fastcgi.conf line if it exists and is commented
if grep -q "^#.*include.*mod_fastcgi.conf" "$LIGHTTPD_CONF"; then
  sed -i 's|^#\(.*include.*mod_fastcgi.conf\)|\1|' "$LIGHTTPD_CONF"
elif ! grep -q "mod_fastcgi.conf" "$LIGHTTPD_CONF"; then
  # Add the include line if it doesn't exist
  echo 'include "mod_fastcgi.conf"' >> "$LIGHTTPD_CONF"
fi

exit 0
