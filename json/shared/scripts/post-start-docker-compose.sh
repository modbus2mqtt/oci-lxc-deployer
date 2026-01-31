#!/bin/sh
# Start Docker Compose services
#
# This script:
# 1. Changes to the project directory
# 2. Starts Docker daemon if not running
# 3. Runs 'docker-compose up -d' to start services
# 4. Checks status of containers
#
# Requires:
#   - compose_project: Project name (directory name)
#
# Output: JSON to stdout (errors to stderr)

COMPOSE_PROJECT="{{ compose_project }}"
VMID="{{ vm_id }}"

if [ -z "$COMPOSE_PROJECT" ]; then
  echo "Error: Required parameter 'compose_project' must be set" >&2
  exit 1
fi

PROJECT_DIR="/opt/docker-compose/$COMPOSE_PROJECT"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Error: Project directory '$PROJECT_DIR' does not exist" >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/docker-compose.yaml" ] && [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "Error: docker-compose.yaml or docker-compose.yml not found in '$PROJECT_DIR'" >&2
  exit 1
fi

# Check if Docker is available
if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker command not found. Please ensure Docker is installed." >&2
  exit 1
fi

# Check if Docker daemon is running (try docker info)
if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker daemon is not running. Please start Docker first." >&2
  echo "For Docker Rootless, ensure dockerd-rootless is running." >&2
  echo "For standard Docker, ensure dockerd service is running." >&2
  exit 1
fi

echo "Docker daemon is running" >&2

# Change to project directory
cd "$PROJECT_DIR" || {
  echo "Error: Failed to change to directory '$PROJECT_DIR'" >&2
  exit 1
}

# Determine compose file name
COMPOSE_FILE=""
if [ -f "docker-compose.yaml" ]; then
  COMPOSE_FILE="docker-compose.yaml"
elif [ -f "docker-compose.yml" ]; then
  COMPOSE_FILE="docker-compose.yml"
fi

# Run docker-compose up -d
echo "Starting Docker Compose services..." >&2
if command -v docker-compose >/dev/null 2>&1; then
  # Use docker-compose command
  docker-compose -f "$COMPOSE_FILE" up -d >&2
  RC=$?
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  # Use docker compose plugin
  docker compose -f "$COMPOSE_FILE" up -d >&2
  RC=$?
else
  echo "Error: Neither 'docker-compose' nor 'docker compose' command found" >&2
  exit 1
fi

if [ $RC -ne 0 ]; then
  echo "Error: Failed to start Docker Compose services (exit code: $RC)" >&2
  exit $RC
fi

# Check container status
echo "Checking container status..." >&2
if command -v docker-compose >/dev/null 2>&1; then
  docker-compose -f "$COMPOSE_FILE" ps >&2
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose -f "$COMPOSE_FILE" ps >&2
fi

echo "Docker Compose services started successfully" >&2
echo '[{"id": "docker_compose_started", "value": "true"}, {"id": "compose_dir", "value": "'"$PROJECT_DIR"'"}]'
