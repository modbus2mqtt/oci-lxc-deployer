# =============================================================================
# Entwicklungsumgebung - Proxmox
# =============================================================================
# WICHTIG: Ersetzen Sie <hostname> mit dem tatsächlichen Hostname
# Generieren Sie ein JWT Secret mit: openssl rand -base64 32
# =============================================================================

# PostgreSQL Configuration
POSTGRES_DB=nebenkosten
POSTGRES_USER=postgres
POSTGRES_PASSWORD=dev_postgres_password_2025_secure_123
POSTGRES_PORT=5432

# Keycloak Database (separate database on same PostgreSQL instance)
KEYCLOAK_DB=keycloak

# PostgREST Configuration
PGRST_DB_SCHEMAS=public
PGRST_DB_ANON_ROLE=anon
PGRST_DB_EXTRA_SEARCH_PATH=public
PGRST_OPENAPI_SERVER_PROXY_URI=http://<hostname>:3000
POSTGREST_PORT=3000

# JWT Configuration (shared between PostgREST and Keycloak)
# WICHTIG: Generieren Sie ein sicheres Secret mit: openssl rand -base64 32
# Beispiel-Secret (ersetzen Sie dies!):
PGRST_JWT_SECRET=pwsvhAfMrhbVNO4PW+T7jrEPGu0mwNNrDAJ84AZVv6M=
PGRST_JWT_AUD=postgrest
PGRST_JWT_EXP=3600

# PostgREST Authorization Settings
PGRST_APP_SETTINGS_AUTHZ_PASS_THROUGH=false
PGRST_APP_SETTINGS_JWT_SECRET=pwsvhAfMrhbVNO4PW+T7jrEPGu0mwNNrDAJ84AZVv6M=
PGRST_APP_SETTINGS_JWT_AUD=postgrest
PGRST_APP_SETTINGS_JWT_EXP=3600

# Keycloak Configuration
KEYCLOAK_HOSTNAME=<hostname>
KEYCLOAK_PORT=8080
KEYCLOAK_HOSTNAME_STRICT=false
KEYCLOAK_HOSTNAME_STRICT_HTTPS=false
KEYCLOAK_HTTP_ENABLED=true
KEYCLOAK_HTTPS_PORT=8443

# Keycloak Admin Credentials
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=dev_keycloak_admin_password_2025_secure_123

# Keycloak Logging and Monitoring
KEYCLOAK_LOG_LEVEL=DEBUG
KEYCLOAK_HEALTH_ENABLED=true
KEYCLOAK_METRICS_ENABLED=true

# Keycloak JWT Settings (for PostgREST integration)
KEYCLOAK_JWT_SIGNATURE_ALGORITHM=RS256

# PostgreSQL data directory (internal, usually not changed)
PGDATA=/var/lib/postgresql/data/pgdata

# PostgREST Database URI (constructed from above)
PGRST_DB_URI=postgres://postgres:dev_postgres_password_2025_secure_123@postgres:5432/nebenkosten

# Keycloak Database Configuration
KC_DB=postgres
KC_DB_URL=jdbc:postgresql://postgres:5432/keycloak
KC_DB_USERNAME=postgres
KC_DB_PASSWORD=dev_postgres_password_2025_secure_123

# Keycloak Hostname Configuration
KC_HOSTNAME=<hostname>
KC_HOSTNAME_PORT=8080
KC_HOSTNAME_STRICT=false
KC_HOSTNAME_STRICT_HTTPS=false
KC_HTTP_ENABLED=true
KC_HTTP_PORT=8080