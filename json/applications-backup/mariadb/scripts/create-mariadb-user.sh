#!/bin/sh
# Create MariaDB user and database
# Inputs (templated):
#   {{ db_user }} - database username
#   {{ db_password }} - database password
#   {{ db_name }} - database name
#   {{ db_host }} - allowed host (default: %)
#   {{ root_password }} - root password (optional)

DB_USER="{{ db_user }}"
DB_PASSWORD="{{ db_password }}"
DB_NAME="{{ db_name }}"
DB_HOST="{{ db_host }}"
ROOT_PASSWORD="{{ root_password }}"

set -eu

# Default to % if db_host is empty
if [ -z "$DB_HOST" ]; then
  DB_HOST="%"
fi

# Determine how to connect to MariaDB
if [ -n "$ROOT_PASSWORD" ]; then
  # Use password authentication
  ESCAPED_ROOT_PASSWORD=$(printf '%s' "$ROOT_PASSWORD" | sed "s/'/''/g")
  cat > /root/.my.cnf <<CNFEOF
[client]
user=root
password=$ROOT_PASSWORD
CNFEOF
  chmod 600 /root/.my.cnf
  MYSQL_CMD="mariadb"
else
  # Use Unix socket authentication
  MYSQL_CMD="mariadb"
fi

# Escape single quotes in passwords for SQL
ESCAPED_DB_PASSWORD=$(printf '%s' "$DB_PASSWORD" | sed "s/'/''/g")

# Create user if it doesn't exist
echo "Creating MariaDB user '$DB_USER'@'$DB_HOST'..." >&2
if ! $MYSQL_CMD <<EOF >&2
CREATE USER IF NOT EXISTS '$DB_USER'@'$DB_HOST' IDENTIFIED BY '$ESCAPED_DB_PASSWORD';
EOF
then
  echo "Error: Failed to create user" >&2
  exit 1
fi

# Create database if it doesn't exist
echo "Creating database '$DB_NAME'..." >&2
if ! $MYSQL_CMD <<EOF >&2
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\`;
EOF
then
  echo "Error: Failed to create database" >&2
  exit 1
fi

# Grant all privileges on the database to the user
echo "Granting all privileges on '$DB_NAME' to '$DB_USER'@'$DB_HOST'..." >&2
if ! $MYSQL_CMD <<EOF >&2
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'$DB_HOST';
FLUSH PRIVILEGES;
EOF
then
  echo "Error: Failed to grant privileges" >&2
  exit 1
fi

# Clean up temporary .my.cnf if created
if [ -n "$ROOT_PASSWORD" ]; then
  rm -f /root/.my.cnf
fi

echo "User and database created successfully" >&2
exit 0
