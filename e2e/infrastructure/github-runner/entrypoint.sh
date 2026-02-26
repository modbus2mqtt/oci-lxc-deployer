#!/bin/bash

# Required environment variables:
#   REPO_URL       - GitHub repository URL (e.g. https://github.com/owner/repo)
#   ACCESS_TOKEN   - GitHub PAT with Actions read/write permission
#   RUNNER_NAME    - Display name for this runner
#   LABELS         - Comma-separated labels (e.g. self-hosted,linux,x64,pve1)

# Runs as root (Dockerfile sets USER root) — needed for DHCP in LXC containers
export RUNNER_ALLOW_RUNASROOT=1

cd /home/runner

# LXC with lxc.init.cmd bypasses the normal init system, so no DHCP client runs.
# Find the first real network interface (skip lo and bonding_masters).
NET_IF=$(ip -o link show 2>/dev/null | awk -F': ' '!/lo|bonding/{print $2; exit}')
if [ -n "$NET_IF" ] && ! ip addr show "$NET_IF" 2>/dev/null | grep -q 'inet '; then
    echo "Requesting DHCP lease for $NET_IF..."
    ip link set "$NET_IF" up 2>/dev/null || true
    dhclient -1 -4 "$NET_IF" 2>/dev/null || true
fi

# Wait for external connectivity
echo "Waiting for network..."
for i in $(seq 1 15); do
    if curl -sf --max-time 2 https://api.github.com >/dev/null 2>&1; then
        echo "Network ready"
        break
    fi
    sleep 1
done

if [ -z "$REPO_URL" ] || [ -z "$ACCESS_TOKEN" ]; then
    echo "ERROR: REPO_URL and ACCESS_TOKEN must be set" >&2
    exit 1
fi

# Set up SSH private key for connecting to test-worker
if [ -n "$SSH_PRIVATE_KEY" ]; then
    mkdir -p /home/runner/.ssh
    echo "$SSH_PRIVATE_KEY" > /home/runner/.ssh/id_ed25519
    chmod 600 /home/runner/.ssh/id_ed25519
    echo "SSH private key installed"
fi

RUNNER_NAME="${RUNNER_NAME:-$(hostname)}"
LABELS="${LABELS:-self-hosted,linux,x64}"
RUNNER_WORKDIR="${RUNNER_WORKDIR:-/tmp/runner-work}"

mkdir -p "$RUNNER_WORKDIR"

# Get registration token from GitHub API
echo "Requesting registration token for $REPO_URL..."
API_URL=$(echo "$REPO_URL" | sed 's|https://github.com/|https://api.github.com/repos/|')
REG_TOKEN=$(curl -s -X POST \
    -H "Authorization: token $ACCESS_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "$API_URL/actions/runners/registration-token" \
    | jq -r '.token')

if [ -z "$REG_TOKEN" ] || [ "$REG_TOKEN" = "null" ]; then
    echo "ERROR: Failed to get registration token" >&2
    exit 1
fi

echo "Configuring runner '$RUNNER_NAME' with labels: $LABELS"

# Configure runner (--replace to handle re-registration)
./config.sh \
    --url "$REPO_URL" \
    --token "$REG_TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$LABELS" \
    --work "$RUNNER_WORKDIR" \
    --unattended \
    --replace

# Cleanup on exit: remove runner registration
cleanup() {
    echo "Removing runner registration..."
    ./config.sh remove --token "$REG_TOKEN" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Start runner
exec ./run.sh
