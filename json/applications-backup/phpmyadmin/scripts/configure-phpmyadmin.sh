#!/bin/sh
# Configure phpMyAdmin (runs inside the container)
# Inputs (templated):
#   {{ db_host }}  - MariaDB hostname or IP
#   {{ db_port }}  - MariaDB port
set -eu

DB_HOST="{{ db_host }}"
DB_PORT="{{ db_port }}"

# Ensure document root directory exists
mkdir -p /var/www/localhost/htdocs >&2
chown -R lighttpd:lighttpd /var/www/localhost/htdocs >&2
chmod 755 /var/www/localhost/htdocs >&2

# Set folder permissions
chmod -R 755 /usr/share/webapps/ >&2
chown -R lighttpd:lighttpd /usr/share/webapps/phpmyadmin >&2
chown -R lighttpd:lighttpd /etc/phpmyadmin >&2

# Remove existing symlink if it's broken, incorrect, or points to wrong location
if [ -L /var/www/localhost/htdocs/phpmyadmin ]; then
  TARGET=$(readlink /var/www/localhost/htdocs/phpmyadmin 2>/dev/null || echo "")
  if [ "$TARGET" != "/usr/share/webapps/phpmyadmin/" ] && [ "$TARGET" != "/usr/share/webapps/phpmyadmin" ]; then
    rm /var/www/localhost/htdocs/phpmyadmin >&2
  elif [ ! -e /var/www/localhost/htdocs/phpmyadmin ]; then
    rm /var/www/localhost/htdocs/phpmyadmin >&2
  fi
fi

# Create symlink to phpmyadmin folder if it doesn't exist
if [ ! -L /var/www/localhost/htdocs/phpmyadmin ]; then
  ln -s /usr/share/webapps/phpmyadmin/ /var/www/localhost/htdocs/phpmyadmin >&2
  chown -h lighttpd:lighttpd /var/www/localhost/htdocs/phpmyadmin >&2
  echo "Created symlink: /var/www/localhost/htdocs/phpmyadmin -> /usr/share/webapps/phpmyadmin/" >&2
else
  echo "Symlink already exists: /var/www/localhost/htdocs/phpmyadmin" >&2
fi

# Generate cookie encryption key
COOKIE_KEY=$(php -r 'echo bin2hex(random_bytes(16)) . PHP_EOL;' 2>&1)

# Update phpmyadmin configuration file
PHPMYADMIN_CONFIG="/etc/phpmyadmin/config.inc.php"
if [ -f "$PHPMYADMIN_CONFIG" ]; then
  # Replace or add blowfish_secret
  if grep -q "blowfish_secret" "$PHPMYADMIN_CONFIG"; then
    # Replace existing blowfish_secret
    sed -i "s|\$cfg\['blowfish_secret'\] = .*|\$cfg['blowfish_secret'] = sodium_hex2bin('${COOKIE_KEY}');|" "$PHPMYADMIN_CONFIG"
  else
    # Add blowfish_secret if it doesn't exist
    echo "\$cfg['blowfish_secret'] = sodium_hex2bin('${COOKIE_KEY}');" >> "$PHPMYADMIN_CONFIG"
  fi
  
  # Configure default server if not already configured
  # Note: No credentials are stored here - users authenticate via the web UI
  if ! grep -q "\$cfg\['Servers'\]\[1\]\['host'\]" "$PHPMYADMIN_CONFIG"; then
    # Add default server configuration
    cat >> "$PHPMYADMIN_CONFIG" <<EOF

// Default server configuration
// Authentication is handled via cookie-based login in the web UI
\$cfg['Servers'][1]['host'] = '${DB_HOST}';
\$cfg['Servers'][1]['port'] = '${DB_PORT}';
EOF
  else
    # Update existing server configuration
    sed -i "s|\$cfg\['Servers'\]\[1\]\['host'\] = .*|\$cfg['Servers'][1]['host'] = '${DB_HOST}';|" "$PHPMYADMIN_CONFIG"
    sed -i "s|\$cfg\['Servers'\]\[1\]\['port'\] = .*|\$cfg['Servers'][1]['port'] = '${DB_PORT}';|" "$PHPMYADMIN_CONFIG"
  fi
else
  echo "Warning: $PHPMYADMIN_CONFIG not found" >&2
fi

exit 0
