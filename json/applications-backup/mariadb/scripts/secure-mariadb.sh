#!/bin/sh
# Secure MariaDB installation
# Inputs (templated):
#   {{ root_password }} - root password (optional)
#   {{ remove_anonymous_users }} - remove anonymous users (true/false)
#   {{ allow_remote_root }} - allow remote root login (true/false)
#   {{ remove_test_database }} - remove test database (true/false)

ROOT_PASSWORD="{{ root_password }}"
REMOVE_ANONYMOUS="{{ remove_anonymous_users }}"
ALLOW_REMOTE_ROOT="{{ allow_remote_root }}"
REMOVE_TEST_DB="{{ remove_test_database }}"

set -eu

# Wait for MariaDB to be ready
echo "Waiting for MariaDB to be ready..." >&2
for i in 1 2 3 4 5 6 7 8 9 10; do
  if mariadb -e "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! mariadb -e "SELECT 1" >/dev/null 2>&1; then
  echo "Error: MariaDB is not responding" >&2
  exit 1
fi

# Set root password if provided
if [ -n "$ROOT_PASSWORD" ]; then
  echo "Setting root password..." >&2
  # Escape single quotes in password for SQL
  ESCAPED_PASSWORD=$(printf '%s' "$ROOT_PASSWORD" | sed "s/'/''/g")
  mariadb <<EOF >&2
ALTER USER 'root'@'localhost' IDENTIFIED BY '$ESCAPED_PASSWORD';
FLUSH PRIVILEGES;
EOF
  # Create temporary .my.cnf for password authentication
  cat > /root/.my.cnf <<CNFEOF
[client]
user=root
password=$ROOT_PASSWORD
CNFEOF
  chmod 600 /root/.my.cnf
  MYSQL_CMD="mariadb"
else
  echo "Using Unix socket authentication for root" >&2
  MYSQL_CMD="mariadb"
fi

# Remove anonymous users if requested
if [ "$REMOVE_ANONYMOUS" = "true" ]; then
  echo "Removing anonymous users..." >&2
  # Get list of anonymous users and drop them
  $MYSQL_CMD -N -e "SELECT CONCAT('DROP USER IF EXISTS ''', User, '''@''', Host, ''';') FROM mysql.user WHERE User='';" 2>/dev/null | while read -r drop_cmd; do
    if [ -n "$drop_cmd" ]; then
      $MYSQL_CMD -e "$drop_cmd" >&2
    fi
  done
  $MYSQL_CMD <<EOF >&2
FLUSH PRIVILEGES;
EOF
fi

# Configure remote root access
if [ "$ALLOW_REMOTE_ROOT" = "true" ]; then
  echo "Allowing remote root login..." >&2
  # Create root user for remote access if it doesn't exist
  if [ -n "$ROOT_PASSWORD" ]; then
    # Escape single quotes in password for SQL
    ESCAPED_PASSWORD=$(printf '%s' "$ROOT_PASSWORD" | sed "s/'/''/g")
    $MYSQL_CMD <<EOF >&2
CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY '$ESCAPED_PASSWORD';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
EOF
  else
    # Without password, use Unix socket authentication (not possible for remote)
    echo "Warning: Cannot enable remote root login without password. Use Unix socket authentication instead." >&2
  fi
else
  echo "Disallowing remote root login..." >&2
  # Remove remote root users
  $MYSQL_CMD <<EOF >&2
DROP USER IF EXISTS 'root'@'%';
FLUSH PRIVILEGES;
EOF
fi

# Remove test database if requested
if [ "$REMOVE_TEST_DB" = "true" ]; then
  echo "Removing test database..." >&2
  $MYSQL_CMD <<EOF >&2
DROP DATABASE IF EXISTS test;
DELETE FROM mysql.db WHERE Db='test' OR Db='test\\_%';
FLUSH PRIVILEGES;
EOF
fi

# Clean up temporary .my.cnf if created
if [ -n "$ROOT_PASSWORD" ]; then
  rm -f /root/.my.cnf
fi

echo "MariaDB secured successfully" >&2
exit 0