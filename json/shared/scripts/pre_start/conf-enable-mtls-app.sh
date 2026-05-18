#!/bin/sh
# Enable mTLS application-specific configuration (no-op default)
#
# This script is called when the mTLS addon is enabled (installation/
# reconfigure), after the client certs have been written by
# conf-generate-mtls-certs.sh. Applications can override this script in their
# own scripts/ directory to perform application-specific mTLS setup (e.g.
# pointing a config file or compose service at the client cert).
#
# Override example: json/applications/zitadel/scripts/conf-enable-mtls-app.sh

echo "No application-specific mTLS configuration needed" >&2
echo '[{"id":"mtls_app_enabled","value":"false"}]'
