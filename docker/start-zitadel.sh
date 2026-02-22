#!/bin/sh

# Ensure we are in the script's directory
cd "$(dirname "$0")" || exit 1

COMPOSE_FILE="Zitadel.docker-compose.yml"
ENV_FILE="Zitadel.env"

echo "Starting Zitadel stack..."
docker-compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

if [ $? -ne 0 ]; then
  echo "Error: Failed to start docker-compose stack."
  docker-compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down

  exit 1
fi

echo "Waiting for services to be healthy..."

# Function to check service health
check_health() {
  service_name=$1
  # Get container ID
  container_id=$(docker-compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q "$service_name")
  
  if [ -z "$container_id" ]; then
    echo "Service $service_name is not running."
    return 1
  fi

  # Check health status if defined, otherwise check if running
  health_status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
  
  if [ "$health_status" = "healthy" ] || [ "$health_status" = "running" ]; then
    echo "Service $service_name is $health_status."
    return 0
  else
    echo "Service $service_name is $health_status. Waiting..."
    return 1
  fi
}

# Wait loop
MAX_RETRIES=30
RETRY_COUNT=0
SLEEP_TIME=2

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  all_healthy=true
  
  # Check Postgres
  check_health "postgres"
  if [ $? -ne 0 ]; then all_healthy=false; fi

  # Check Zitadel
  check_health "zitadel"
  if [ $? -ne 0 ]; then all_healthy=false; fi

  # Check Login
  check_health "login"
  if [ $? -ne 0 ]; then all_healthy=false; fi

  # Check PostgREST
  check_health "postgrest"
  if [ $? -ne 0 ]; then all_healthy=false; fi

  if [ "$all_healthy" = "true" ]; then
    echo "All services started successfully!"
    exit 0
  fi

  sleep $SLEEP_TIME
  RETRY_COUNT=$((RETRY_COUNT + 1))
done

echo "Timeout waiting for services to start."
exit 1
