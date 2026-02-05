# Docker Compose Installation Guide

## Übersicht

Dieses Verzeichnis enthält Docker Compose Konfigurationen für verschiedene Services. Alle Compose-Dateien sind so konzipiert, dass sie mit einer gemeinsamen `.env` Datei funktionieren.

**Wichtig:** Die `.env` Datei wird aus Sicherheitsgründen **nicht** in der `application.json` gespeichert. Sie muss beim Deployment im **ve-configuration-dialog** hochgeladen werden.

## Verfügbare Services

| Service | Compose-Datei | Standard-Port | Beschreibung |
|---------|--------------|---------------|--------------|
| PostgreSQL | `postgres.docker-compose.yml` | 5432 | Relationale Datenbank |
| MariaDB | `mariadb.docker-compose.yml` | 3306 | MySQL-kompatible Datenbank |
| pgAdmin | `pgadmin.docker-compose.yml` | 5050 | PostgreSQL Web-Admin |
| phpMyAdmin | `phpmyadmin.docker-compose.yml` | 8080 | MariaDB/MySQL Web-Admin |
| PostgREST | `postgrest.docker-compose.yml` | 3000 | REST API für PostgreSQL |
| Zitadel | `Zitadel.docker-compose.yml` | 8080 | Identity Provider |
| Mosquitto | `mosquitto.docker-compose.yml` | 1883/9001 | MQTT Broker |
| Node-RED | `node-red.docker-compose.yml` | 1880 | Flow-basierte Entwicklung |
| Modbus2MQTT | `modbus2mqtt.docker-compose.yml` | 3000 | Modbus zu MQTT Bridge |

---

## Installationsreihenfolge

### Gruppe 1: Standalone-Datenbanken (können unabhängig installiert werden)

```
1. postgres.docker-compose.yml    - PostgreSQL Datenbank
2. mariadb.docker-compose.yml     - MariaDB Datenbank
```

### Gruppe 2: Datenbank-Abhängige Services

```
3. pgadmin.docker-compose.yml     - Benötigt: PostgreSQL
4. phpmyadmin.docker-compose.yml  - Benötigt: MariaDB
5. postgrest.docker-compose.yml   - Benötigt: PostgreSQL + .env (POSTGRES_PASSWORD, JWT_SECRET)
6. Zitadel.docker-compose.yml     - Benötigt: PostgreSQL + .env (POSTGRES_PASSWORD, ZITADEL_MASTERKEY)
```

### Gruppe 3: MQTT-Basierte Services

```
7. mosquitto.docker-compose.yml   - MQTT Broker (standalone)
8. node-red.docker-compose.yml    - Kann mit Mosquitto verbunden werden
9. modbus2mqtt.docker-compose.yml - Kann mit Mosquitto verbunden werden
```

---

## .env Datei erstellen

### Schritt 1: Template kopieren

```bash
cp .env.template .env
```

### Schritt 2: Platzhalter ersetzen

Ersetzen Sie die `{{ PLACEHOLDER }}` Werte durch Ihre echten Credentials:

```env
# Template:
POSTGRES_PASSWORD={{ POSTGRES_PASSWORD }}

# Ersetzen durch:
POSTGRES_PASSWORD=MeinSicheresPasswort123!
```

### Pflicht-Variablen für verschiedene Services

| Variable | Benötigt für | Beschreibung |
|----------|-------------|--------------|
| `POSTGRES_PASSWORD` | postgrest, zitadel, pgadmin | PostgreSQL Datenbank-Passwort |
| `JWT_SECRET` | postgrest | JWT-Validierung (min. 32 Zeichen) |
| `ZITADEL_MASTERKEY` | zitadel | Verschlüsselung (min. 32 Zeichen) |

---

## Deployment via OCI LXC Deployer

### 1. Application erstellen

```bash
# Im OCI LXC Deployer: create-application mit docker-compose.yml
# Die .env wird NICHT in application.json gespeichert (Sicherheit)
```

### 2. Deployment im ve-configuration-dialog

1. **VE Configuration Dialog** öffnen
2. Im Feld **"Environment File (.env)"** die `.env` Datei hochladen
3. **Deploy** klicken

Die `.env` Datei wird erst beim Deployment direkt in den Container geschrieben:
`/opt/docker-compose/<project>/.env`

---

## Passwörter, die NICHT in .env sein müssen

Diese Passwörter werden nur **einmalig beim ersten Start** verwendet und können dann in der jeweiligen Anwendung geändert werden:

### pgAdmin

- **Initial-Passwort**: `admin` (fest im Compose)
- **Initial-E-Mail**: `admin@local.dev`
- **Ändern**: Nach Login im pgAdmin Web-Interface unter "Change Password"

### Zitadel Admin

- **Initial-Benutzer**: `admin`
- **Initial-Passwort**: `Password1!`
- **Ändern**: Nach Login in Zitadel Console unter "Account Settings"

### MariaDB

- **Root-Passwort**: `secret123` (Default)
- **Ändern nach Start**:
  ```sql
  ALTER USER 'root'@'localhost' IDENTIFIED BY 'neues_passwort';
  ALTER USER 'root'@'%' IDENTIFIED BY 'neues_passwort';
  FLUSH PRIVILEGES;
  ```

### PostgreSQL (Standalone)

- **Passwort**: `secret123` (Default für `postgres.docker-compose.yml`)
- **Ändern nach Start**:
  ```sql
  ALTER USER postgres WITH PASSWORD 'neues_passwort';
  ```

### Mosquitto MQTT

- Standardmäßig **keine Authentifizierung**
- **Aktivieren**: Erstellen Sie `./config/mosquitto.conf`:
  ```
  listener 1883
  allow_anonymous false
  password_file /mosquitto/config/passwd
  ```
- **Passwort setzen**:
  ```bash
  docker exec -it mosquitto mosquitto_passwd -c /mosquitto/config/passwd mqtt_user
  ```

### Node-RED

- Standardmäßig **keine Authentifizierung**
- **Aktivieren**: Bearbeiten Sie `./data/settings.js`:
  ```javascript
  adminAuth: {
      type: "credentials",
      users: [{
          username: "admin",
          password: "$2b$08$...", // bcrypt hash
          permissions: "*"
      }]
  }
  ```
- **Passwort-Hash generieren**:
  ```bash
  docker exec -it node-red npx node-red admin hash-pw
  ```

---

## Optionale Variablen

Diese Variablen haben sinnvolle Defaults und müssen nur bei Bedarf angepasst werden:

```env
# Ports
POSTGRES_PORT=5432
MARIADB_PORT=3306
PGADMIN_PORT=5050
PHPMYADMIN_PORT=8080
POSTGREST_PORT=3000
ZITADEL_PORT=8080
MQTT_PORT=1883
MQTT_WS_PORT=9001
NODERED_PORT=1880
MODBUS2MQTT_PORT=3000

# Versionen
POSTGRES_VERSION=16-alpine
MARIADB_VERSION=11
PGADMIN_VERSION=latest
PHPMYADMIN_VERSION=latest
POSTGREST_VERSION=latest
ZITADEL_VERSION=latest
MOSQUITTO_VERSION=2
NODERED_VERSION=latest
MODBUS2MQTT_VERSION=latest

# PostgreSQL
POSTGRES_USER=postgres
POSTGRES_DB=postgres

# MariaDB
MARIADB_DATABASE=appdb
MARIADB_USER=appuser

# Zitadel
ZITADEL_EXTERNALDOMAIN=localhost
ZITADEL_EXTERNALSECURE=false
ZITADEL_DB=zitadel

# PostgREST
PGRST_SCHEMAS=public
PGRST_ANON_ROLE=anon

# pgAdmin
PGADMIN_EMAIL=admin@local.dev
```

---

## Sicherheitshinweise

1. **Keine Passwörter in application.json**: Die `.env` wird aus Sicherheitsgründen nicht gespeichert
2. **Template verwenden**: Kopieren Sie `.env.template` zu `.env` und ersetzen Sie die Platzhalter
3. **Sichere Passwörter**: Verwenden Sie starke, zufällige Passwörter (min. 16 Zeichen)
4. **Backup der .env**: Die `.env` Datei sicher aufbewahren (nicht in Git committen!)
5. **Firewall**: Nur benötigte Ports nach außen freigeben

---

## Dateien in diesem Verzeichnis

| Datei | Beschreibung |
|-------|--------------|
| `*.docker-compose.yml` | Docker Compose Konfigurationen |
| `.env.template` | Template mit Platzhaltern (sicher versionierbar) |
| `.env` | Echte Credentials (NICHT committen!) |
| `INSTALLATION.md` | Diese Dokumentation |
