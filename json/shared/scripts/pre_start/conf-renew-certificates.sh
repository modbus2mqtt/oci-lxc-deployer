#!/bin/sh
# Renew Certificates
#
# Force-renews certificates for specified hostnames.
# Ignores existing cert validity check - always regenerates.
#
# Template variables:
#   cert_renew_requests - Multiline: hostname|certtype|volumeKey per line
#   ca_key_b64          - Base64-encoded CA private key PEM
#   ca_cert_b64         - Base64-encoded CA certificate PEM
#   shared_volpath      - Base path for volumes
#   domain_suffix       - FQDN suffix (default: .local)

# Library functions are prepended automatically:
# - cert_generate_server(), cert_generate_fullchain()
# - cert_write_ca_pub(), cert_write_ca()
# - cert_output_result()

CERT_RENEW_REQUESTS="{{ cert_renew_requests }}"
CA_KEY_B64="{{ ca_key_b64 }}"
CA_CERT_B64="{{ ca_cert_b64 }}"
SHARED_VOLPATH="{{ shared_volpath }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"

# Default shared_volpath if not set
if [ -z "$SHARED_VOLPATH" ] || [ "$SHARED_VOLPATH" = "NOT_DEFINED" ]; then
  SHARED_VOLPATH="/mnt/shared"
fi

if [ -z "$DOMAIN_SUFFIX" ] || [ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ]; then
  DOMAIN_SUFFIX=".local"
fi

echo "Renewing certificates..." >&2

echo "$CERT_RENEW_REQUESTS" | while IFS='|' read -r HOSTNAME CERTTYPE VOLUME_KEY; do
  [ -z "$HOSTNAME" ] && continue

  FQDN="${HOSTNAME}${DOMAIN_SUFFIX}"
  SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
  SAFE_VOL=$(echo "$VOLUME_KEY" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
  TARGET_DIR="${SHARED_VOLPATH}/volumes/${SAFE_HOST}/${SAFE_VOL}"

  echo "Renewing: ${HOSTNAME} (${CERTTYPE}) -> ${TARGET_DIR}" >&2

  if [ ! -d "$TARGET_DIR" ]; then
    echo "Warning: Volume directory '${TARGET_DIR}' not found, creating" >&2
    mkdir -p "$TARGET_DIR"
  fi

  case "$CERTTYPE" in
    server)
      cert_generate_server "$CA_KEY_B64" "$CA_CERT_B64" "$FQDN" "$TARGET_DIR" "$HOSTNAME"
      ;;
    fullchain)
      cert_generate_fullchain "$CA_KEY_B64" "$CA_CERT_B64" "$FQDN" "$TARGET_DIR" "$HOSTNAME"
      ;;
    ca_pub)
      cert_write_ca_pub "$CA_CERT_B64" "$TARGET_DIR"
      ;;
    ca)
      cert_write_ca "$CA_KEY_B64" "$CA_CERT_B64" "$TARGET_DIR"
      ;;
    *)
      echo "Warning: Unknown certtype '${CERTTYPE}' for ${HOSTNAME}, skipping" >&2
      ;;
  esac
done

cert_output_result "certs_renewed"
