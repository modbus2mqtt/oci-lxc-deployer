#!/bin/sh
# Upload Docker Compose files to LXC container
#
# This script:
# 1. Decodes base64-encoded Docker Compose file
# 2. Writes it to /opt/docker-compose/<project>/docker-compose.yaml
# 3. Decodes base64-encoded .env file (if provided)
# 4. Writes it to /opt/docker-compose/<project>/.env
# 5. Sets correct permissions
#
# Requires:
#   - compose_file: Base64-encoded Docker Compose file (from upload parameter)
#   - env_file: Base64-encoded .env file (optional, from upload parameter)
#   - compose_project: Project name (directory name)
#
# Output: JSON to stdout (errors to stderr)

COMPOSE_FILE_B64="{{ compose_file }}"
ENV_FILE_B64="{{ env_file }}"
COMPOSE_PROJECT="{{ compose_project }}"
VMID="{{ vm_id }}"

if [ -z "$COMPOSE_PROJECT" ]; then
  echo "Error: Required parameter 'compose_project' must be set" >&2
  exit 1
fi

if [ -z "$COMPOSE_FILE_B64" ] || [ "$COMPOSE_FILE_B64" = "" ]; then
  echo "Error: Required parameter 'compose_file' must be set" >&2
  exit 1
fi

# Create project directory
PROJECT_DIR="/opt/docker-compose/$COMPOSE_PROJECT"
mkdir -p "$PROJECT_DIR"

# Decode and write docker-compose.yaml
echo "Writing docker-compose.yaml to $PROJECT_DIR/docker-compose.yaml..." >&2
echo "$COMPOSE_FILE_B64" | base64 -d > "$PROJECT_DIR/docker-compose.yaml"
if [ $? -ne 0 ]; then
  echo "Error: Failed to decode or write docker-compose.yaml" >&2
  exit 1
fi

# Set permissions for compose file
chmod 644 "$PROJECT_DIR/docker-compose.yaml"

# Decode and write .env file if provided
if [ -n "$ENV_FILE_B64" ] && [ "$ENV_FILE_B64" != "" ] && [ "$ENV_FILE_B64" != "NOT_DEFINED" ]; then
  echo "Writing .env file to $PROJECT_DIR/.env..." >&2
  echo "$ENV_FILE_B64" | base64 -d > "$PROJECT_DIR/.env"
  if [ $? -ne 0 ]; then
    echo "Error: Failed to decode or write .env file" >&2
    exit 1
  fi
  chmod 644 "$PROJECT_DIR/.env"
else
  echo "No .env file provided, skipping" >&2
fi

# Set directory permissions
chmod 755 "$PROJECT_DIR"

echo "Docker Compose files uploaded successfully to $PROJECT_DIR" >&2
echo '[{"id": "compose_files_uploaded", "value": "true"}, {"id": "compose_dir", "value": "'"$PROJECT_DIR"'"}]'
