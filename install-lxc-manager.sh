#!/bin/sh
set -eu

# install-lxc-manager.sh
# Minimal installation script for lxc-manager as an LXC container on Proxmox
# Downloads OCI image, creates container, mounts volumes, and writes storagecontext.json

# Static GitHub source configuration
OCI_OWNER="modbus2mqtt"
#OWNER="volkmarnissen"
OWNER="modbus2mqtt"
REPO="lxc-manager"
BRANCH="main"
OCI_IMAGE="ghcr.io/${OCI_OWNER}/lxc-manager:latest"

# Helper functions
execute_script_from_github() {
  if [ "$#" -lt 2 ]; then
    echo "Usage: execute_script_from_github <path> <output_id|-> [key=value ...]" >&2
    return 2
  fi
  path="$1"; output_id="$2"; shift 2

  raw_url="https://raw.githubusercontent.com/${OWNER}/${REPO}/refs/heads/${BRANCH}/${path}"
  sed_args=""
  for kv in "$@"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    esc_val=$(printf '%s' "$val" | sed 's/[\\&/]/\\&/g')
    sed_args="$sed_args -e s/{{[[:space:]]*$key[[:space:]]*}}/$esc_val/g"
  done

  # Determine interpreter based on file extension
  case "$path" in
    *.py) interpreter="python3" ;;
    *.sh) interpreter="sh" ;;
    *) interpreter="sh" ;;
  esac

  script_content=$(curl -fsSL "$raw_url" | sed $sed_args)

  # Some Python scripts depend on shared helpers but are still executed via stdin.
  # Prepend the helper library explicitly when needed.
  case "$path" in
    json/shared/scripts/setup-lxc-uid-mapping.py|json/shared/scripts/setup-lxc-gid-mapping.py)
      lib_url="https://raw.githubusercontent.com/${OWNER}/${REPO}/refs/heads/${BRANCH}/json/shared/scripts/setup_lxc_idmap_common.py"
      lib_content=$(curl -fsSL "$lib_url")
      script_content=$(printf '%s\n\n%s' "$lib_content" "$script_content")
      ;;
  esac

  if [ "$output_id" = "-" ]; then
    printf '%s' "$script_content" | $interpreter
    return $?
  fi

  script_output=$(printf '%s' "$script_content" | $interpreter)
  output_value=$(printf '%s\n' "$script_output" \
    | awk -v ID="$output_id" '
      BEGIN { FS="\"" }
      /"id"[[:space:]]*:[[:space:]]*"/ {
        for (i=1; i<=NF; i++) {
          if ($i=="id" && $(i+2)==ID) {
            for (j=i; j<=NF; j++) {
              if ($j=="value") { print $(j+2); exit }
            }
          }
        }
      }')
  
  if [ -n "$output_value" ]; then
    printf '%s\n' "$output_value"
    return 0
  else
    echo "ERROR: Output id '$output_id' not found" >&2
    printf '%s\n' "$script_output" >&2
    return 3
  fi
}

# Defaults
vm_id=""
disk_size="1"
memory="512"
bridge="vmbr0"
hostname="lxc-manager"
config_volume_path=""
secure_volume_path=""
storage="local"

# Known UID/GID from Dockerfile (lxc user)
LXC_UID=1001
LXC_GID=1001

# Parse CLI flags
while [ "$#" -gt 0 ]; do
  case "$1" in
    --vm-id) vm_id="$2"; shift 2 ;;
    --disk-size) disk_size="$2"; shift 2 ;;
    --memory) memory="$2"; shift 2 ;;
    --bridge) bridge="$2"; shift 2 ;;
    --hostname) hostname="$2"; shift 2 ;;
    --config-volume) config_volume_path="$2"; shift 2 ;;
    --secure-volume) secure_volume_path="$2"; shift 2 ;;
    --storage) storage="$2"; shift 2 ;;
    --help|-h)
      cat >&2 <<USAGE
Usage: $0 [options]

Installs lxc-manager as an LXC container from OCI image on a Proxmox host.

Options:
  --vm-id <id>          Optional VMID. If empty, the next free VMID is chosen.
  --disk-size <GB>      LXC rootfs size in GB. Default: 1
  --memory <MB>         Container memory in MB. Default: 512
  --bridge <name>       Network bridge (e.g. vmbr0). Default: vmbr0
  --hostname <name>     Container hostname. Default: lxc-manager
  --config-volume <path> Host path for /config volume (default: /mnt/volumes/\$hostname/config)
  --secure-volume <path> Host path for /secure volume (default: /mnt/volumes/\$hostname/secure)
  --storage <name>      Proxmox storage for OCI image. Default: local

Notes:
  - OCI image: ${OCI_IMAGE}
  - Container UID/GID: ${LXC_UID}/${LXC_GID}
  - Network configuration (IP, gateway, etc.) should be done directly in Proxmox after installation
  - The script creates a storagecontext.json file for repeatable installations
USAGE
      exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Detect ZFS pool and mountpoint for volumes
detect_volume_base_path() {
  # Check for ZFS pools first (common in Proxmox)
  if command -v zpool >/dev/null 2>&1 && command -v zfs >/dev/null 2>&1; then
    # Try common pool names: rpool, tank, data
    for pool in rpool tank data; do
      if zpool list "$pool" >/dev/null 2>&1; then
        mountpoint=$(zfs get -H -o value mountpoint "$pool" 2>/dev/null || echo "")
        if [ -n "$mountpoint" ] && [ "$mountpoint" != "none" ] && [ "$mountpoint" != "-" ] && [ -d "$mountpoint" ]; then
          # Check for volumes subdirectory (common pattern)
          if [ -d "${mountpoint}/volumes" ]; then
            echo "${mountpoint}/volumes"
            return 0
          else
            # Use pool mountpoint directly
            echo "$mountpoint"
            return 0
          fi
        fi
      fi
    done
  fi
  
  # Fallback to /mnt/volumes
  echo "/mnt/volumes"
}

# Set default volume paths if not provided
volume_base=$(detect_volume_base_path)
if [ -z "$config_volume_path" ]; then
  config_volume_path="${volume_base}/${hostname}/config"
fi
if [ -z "$secure_volume_path" ]; then
  secure_volume_path="${volume_base}/${hostname}/secure"
fi

# Get Proxmox hostname for VE context (use FQDN)
proxmox_hostname=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "localhost")

echo "Installing lxc-manager..." >&2
echo "  OCI Image: ${OCI_IMAGE}" >&2
echo "  Hostname: ${hostname}" >&2
echo "  Proxmox Host: ${proxmox_hostname}" >&2
echo "  Volume base: ${volume_base}" >&2
echo "  Config volume: ${config_volume_path}" >&2
echo "  Secure volume: ${secure_volume_path}" >&2

# Check and install SSH server if needed (on Proxmox VE host)
# This matches the installation command from the SSH config page
echo "Step 0: Installing and hardening SSH server..." >&2
# Check if SSH port is listening
if ! nc -z localhost 22 2>/dev/null && ! timeout 2 nc -z localhost 22 2>/dev/null; then
  echo "  SSH server not listening, installing and configuring..." >&2
  
  # Install openssh-server if apt-get exists (Proxmox is Debian-based)
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server >/dev/null 2>&1 || {
      echo "Warning: Failed to install openssh-server" >&2
    }
  fi
  
  # Prepare directories
  mkdir -p /root/.ssh /var/run/sshd /etc/ssh/sshd_config.d
  
  # Write lxc-manager drop-in configuration (matches ssh.mts getInstallSshServerCommand)
  cat > /etc/ssh/sshd_config.d/lxc-manager.conf <<'SSHCONF'
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM no
AuthorizedKeysFile .ssh/authorized_keys .ssh/authenticated_keys
AllowUsers root
SSHCONF
  
  # Enable and restart SSH service
  systemctl enable ssh >/dev/null 2>&1 || systemctl enable sshd >/dev/null 2>&1 || true
  systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1 || \
  service ssh restart >/dev/null 2>&1 || service sshd restart >/dev/null 2>&1 || {
    echo "Warning: Failed to restart SSH server" >&2
  }
  
  echo "  SSH server installed and hardened" >&2
else
  echo "  SSH server already listening" >&2
  # Still ensure drop-in config exists (may have been removed)
  if [ ! -f /etc/ssh/sshd_config.d/lxc-manager.conf ]; then
    echo "  Adding lxc-manager SSH configuration..." >&2
    mkdir -p /etc/ssh/sshd_config.d
    cat > /etc/ssh/sshd_config.d/lxc-manager.conf <<'SSHCONF'
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM no
AuthorizedKeysFile .ssh/authorized_keys .ssh/authenticated_keys
AllowUsers root
SSHCONF
    systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1 || true
  fi
fi

# 1) Download OCI image
echo "Step 1: Downloading OCI image..." >&2
template_path=$(execute_script_from_github \
  "json/shared/scripts/get-oci-image.py" \
  "template_path" \
  "oci_image=${OCI_IMAGE}" \
  "storage=${storage}" \
  "registry_username=" \
  "registry_password=" \
  "platform=linux/amd64")

if [ -z "$template_path" ]; then
  echo "Error: Failed to download OCI image" >&2
  exit 1
fi

ostype=$(execute_script_from_github \
  "json/shared/scripts/get-oci-image.py" \
  "ostype" \
  "oci_image=${OCI_IMAGE}" \
  "storage=${storage}" \
  "registry_username=" \
  "registry_password=" \
  "platform=linux/amd64")

echo "  OCI image ready: ${template_path}" >&2


# 2) Create LXC container from OCI image
echo "Step 2: Creating LXC container..." >&2
vm_id=$(execute_script_from_github \
  "json/shared/scripts/create-lxc-container.sh" \
  "vm_id" \
  "template_path=${template_path}" \
  "vm_id=${vm_id}" \
  "disk_size=${disk_size}" \
  "memory=${memory}" \
  "bridge=${bridge}" \
  "hostname=${hostname}" \
  "ostype=${ostype}")

if [ -z "$vm_id" ]; then
  echo "Error: Failed to create LXC container" >&2
  exit 1
fi

echo "  Container created: ${vm_id}" >&2
# 3) Configure UID/GID mapping (subuid/subgid only, container config after creation)
echo "Step 3: Configuring UID/GID mapping..." >&2
# Run mapping script and capture mapped UID/GID for later steps (idempotent to call twice)
mapped_uid=$(execute_script_from_github \
  "json/shared/scripts/setup-lxc-uid-mapping.py" \
  "mapped_uid" \
  "uid=${LXC_UID}" \
  "vm_id=${vm_id}" || echo "")
mapped_gid=$(execute_script_from_github \
  "json/shared/scripts/setup-lxc-gid-mapping.py" \
  "mapped_gid" \
  "gid=${LXC_GID}" \
  "vm_id=${vm_id}" || echo "")

# Fallback to defaults if mapper returned nothing
if [ -z "$mapped_uid" ]; then mapped_uid="$LXC_UID"; fi
if [ -z "$mapped_gid" ]; then mapped_gid="$LXC_GID"; fi

echo "  UID/GID ranges configured; mapped_uid=${mapped_uid}, mapped_gid=${mapped_gid}" >&2

# 4) Mount ZFS pool if using ZFS storage
echo "Step 4: Preparing storage..." >&2
# Determine if we're using ZFS
host_mountpoint=""
if echo "$volume_base" | grep -q "^/"; then
  # Check if this is a ZFS mountpoint
  if command -v zfs >/dev/null 2>&1; then
    zfs_pool=$(echo "$volume_base" | cut -d'/' -f2)
    if zpool list "$zfs_pool" >/dev/null 2>&1; then
      echo "  Detected ZFS pool: $zfs_pool" >&2
      host_mountpoint=$(execute_script_from_github \
        "json/shared/scripts/mount-zfs-pool.sh" \
        "host_mountpoint" \
        "storage_selection=zfs:${zfs_pool}" \
        "uid=${LXC_UID}" \
        "gid=${LXC_GID}" \
        "mapped_uid=${mapped_uid}" \
        "mapped_gid=${mapped_gid}")
      if [ -z "$host_mountpoint" ]; then
        echo "Error: Failed to mount ZFS pool" >&2
        exit 1
      fi
      echo "  ZFS pool mounted at: ${host_mountpoint}" >&2
    else
      # Not ZFS, use volume_base directly
      host_mountpoint=$(dirname "$volume_base")
    fi
  else
    # No ZFS tools, use volume_base directly
    host_mountpoint=$(dirname "$volume_base")
  fi
fi

# 5) Bind volumes to container
echo "Step 5: Binding volumes to container..." >&2
# Log context for permissions/mapping
echo "  Host: ${proxmox_hostname}" >&2
echo "  Container ID: ${vm_id}, Container hostname: ${hostname}" >&2
echo "  Using UID/GID: ${LXC_UID}/${LXC_GID} (mapped: ${mapped_uid}/${mapped_gid})" >&2
# Set volumes as environment variable for the script
export VOLUMES="config=config
secure=secure,0700"

# Use execute_script_from_github - VOLUMES is passed via environment
if ! execute_script_from_github \
  "json/shared/scripts/bind-multiple-volumes-to-lxc.sh" \
  "-" \
  "vm_id=${vm_id}" \
  "hostname=${hostname}" \
  "base_path=volumes" \
  "host_mountpoint=${host_mountpoint}" \
  "username=" \
  "uid=${LXC_UID}" \
  "gid=${LXC_GID}" \
  "mapped_uid=${mapped_uid}" \
  "mapped_gid=${mapped_gid}" \
  "volumes=\$VOLUMES"; then
  echo "Error: Failed to bind volumes to container" >&2
  exit 1
fi

echo "  Volumes bound successfully" >&2

# Update volume paths to match what was created
if [ -n "$host_mountpoint" ]; then
  config_volume_path="${host_mountpoint}/volumes/${hostname}/config"
  secure_volume_path="${host_mountpoint}/volumes/${hostname}/secure"
fi

# Write storagecontext.json before starting the container so the app can read it on startup
echo "Step 5.1: Writing storagecontext.json to /config..." >&2
storagecontext_file="${config_volume_path}/storagecontext.json"
# Prepare changed params for VMInstall context
changed_params_json="[
  {\"name\":\"vm_id\",\"value\":\"${vm_id}\"},
  {\"name\":\"hostname\",\"value\":\"${hostname}\"},
  {\"name\":\"disk_size\",\"value\":${disk_size}},
  {\"name\":\"memory\",\"value\":${memory}},
  {\"name\":\"bridge\",\"value\":\"${bridge}\"},
  {\"name\":\"config_volume_path\",\"value\":\"${config_volume_path}\"},
  {\"name\":\"secure_volume_path\",\"value\":\"${secure_volume_path}\"},
  {\"name\":\"oci_image\",\"value\":\"${OCI_IMAGE}\"},
  {\"name\":\"storage\",\"value\":\"${storage}\"}
]"
mkdir -p "$(dirname "${storagecontext_file}")" 2>/dev/null || true
cat > "${storagecontext_file}" <<JSON
{
  "ve_${proxmox_hostname}": {
    "host": "${proxmox_hostname}",
    "port": 22,
    "current": true
  },
  "vminstall_${hostname}_lxc-manager": {
    "hostname": "${hostname}",
    "application": "lxc-manager",
    "task": "installation",
    "changedParams": ${changed_params_json}
  }
}
JSON
echo "  storagecontext.json written at: ${storagecontext_file}" >&2

# 6) Ensure container is running
echo "Step 6: Ensuring container is running..." >&2
if ! pct status "${vm_id}" | grep -q "running"; then
  pct start "${vm_id}" || {
    echo "Error: Failed to start container" >&2
    exit 1
  }
  # Wait for container to be ready
  echo "  Waiting for container to be ready..." >&2
  sleep 3
  for i in 1 2 3 4 5; do
    if pct status "${vm_id}" | grep -q "running"; then
      break
    fi
    sleep 2
  done
fi

if ! pct status "${vm_id}" | grep -q "running"; then
  echo "Warning: Container may not be fully ready" >&2
else
  echo "  Container is running" >&2
fi

  # Ensure SSH keys persist in /secure: symlink /home/lxc/.ssh -> /secure/.ssh
  lxc-attach -n "${vm_id}" -- sh -c "\
    mkdir -p /secure/.ssh && \
    chown -R lxc:lxc /secure && \
    chmod 700 /secure && \
    chmod 700 /secure/.ssh && \
    rm -rf /home/lxc/.ssh && \
    ln -sfn /secure/.ssh /home/lxc/.ssh && \
    chown -h lxc:lxc /home/lxc/.ssh\
  " >/dev/null 2>&1 || true

# 7) Get SSH public key from container and add to root authorized_keys
echo "Step 7: Setting up SSH access..." >&2
# Wait for container and application to be ready
echo "  Waiting for container application to start..." >&2
sleep 5

# Try to get SSH public key from container
# The key is generated when the application starts, so we need to wait for it
container_pubkey=""
max_attempts=10
attempt=0

while [ $attempt -lt $max_attempts ]; do
  attempt=$((attempt + 1))
  
  # Try multiple locations where the key might be
  # Based on ssh.mts: /home/lxc/.ssh/id_ed25519.pub (LXC_MANAGER_USER_HOME=/home/lxc)
  # Also check /var/lib/lxc-manager and /home/lxc-manager
  for key_path in \
    "/home/lxc/.ssh/id_ed25519.pub" \
    "/home/lxc/.ssh/id_rsa.pub" \
    "/var/lib/lxc-manager/.ssh/id_ed25519.pub" \
    "/var/lib/lxc-manager/.ssh/id_rsa.pub" \
    "/home/lxc-manager/.ssh/id_ed25519.pub" \
    "/home/lxc-manager/.ssh/id_rsa.pub"; do
    container_pubkey=$(lxc-attach -n "${vm_id}" -- cat "$key_path" 2>/dev/null | grep -v "^$" || echo "")
    if [ -n "$container_pubkey" ]; then
      echo "  Found SSH public key at: $key_path" >&2
      break 2
    fi
  done
  
  # Do not generate keys here; the application will generate them at startup
  
  if [ $attempt -lt $max_attempts ]; then
    sleep 3
  fi
done

if [ -n "$container_pubkey" ]; then
  echo "  Found SSH public key in container" >&2
  # Add to root authorized_keys if not already present
  root_ssh_dir="/root/.ssh"
  root_auth_keys="${root_ssh_dir}/authorized_keys"
  
  mkdir -p "${root_ssh_dir}"
  chmod 700 "${root_ssh_dir}"
  
  # Resolve symlink to get actual file path
  if [ -L "${root_auth_keys}" ]; then
    actual_auth_keys=$(readlink -f "${root_auth_keys}")
    echo "  authorized_keys is a symlink to: ${actual_auth_keys}" >&2
  else
    actual_auth_keys="${root_auth_keys}"
  fi
  
  # Check if key already exists
  if [ -f "${actual_auth_keys}" ] && grep -qF "${container_pubkey}" "${actual_auth_keys}" 2>/dev/null; then
    echo "  SSH key already in root authorized_keys" >&2
  else
    echo "${container_pubkey}" >> "${actual_auth_keys}"
    echo "  Added SSH key to root authorized_keys" >&2
  fi
  
  # Check and fix permissions only if needed
  current_owner=$(stat -c '%U:%G' "${actual_auth_keys}" 2>/dev/null || stat -f '%Su:%Sg' "${actual_auth_keys}" 2>/dev/null || echo "")
  current_perms=$(stat -c '%a' "${actual_auth_keys}" 2>/dev/null || stat -f '%Lp' "${actual_auth_keys}" 2>/dev/null || echo "")
  
  if [ "$current_owner" != "root:root" ]; then
    echo "  Fixing ownership of ${actual_auth_keys}" >&2
    chown root:root "${actual_auth_keys}" 2>/dev/null || true
  fi
  
  if [ "$current_perms" != "600" ]; then
    echo "  Fixing permissions of ${actual_auth_keys}" >&2
    chmod 600 "${actual_auth_keys}" 2>/dev/null || true
  fi
  
  # SSH key installed; no SSH service restart required
  echo "  SSH key installed and permissions hardened (no SSH restart)" >&2
else
  echo "  Warning: Could not retrieve SSH public key from container after ${max_attempts} attempts" >&2
  echo "  The key will be generated when the application starts" >&2
  echo "  You can add it later using the SSH config page in the web interface" >&2
fi

# 8) Application startup note (no API configuration; app reads storagecontext.json)
echo "Step 8: Application startup context ready (no API calls)" >&2

echo "" >&2
echo "Installation complete!" >&2
echo "  Container ID: ${vm_id}" >&2
echo "  Hostname: ${hostname}" >&2
echo "  Config: ${config_volume_path}" >&2
echo "  Secure: ${secure_volume_path}" >&2
echo "" >&2
echo "  Access the web interface at http://${hostname}:3000" >&2

exit 0
