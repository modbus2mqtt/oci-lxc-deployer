# Live Integration Tests

Diese Tests erstellen echte Container auf einem Proxmox VE Host und verifizieren die Funktionalität.

## Voraussetzungen

1. **SSH-Zugang zum PVE-Host**

   ```bash
   ssh pve1.cluster  # Muss ohne Passwort funktionieren
   ```

2. **Backend ist gebaut**
   ```bash
   cd backend && npm run build
   ```

Das Script erstellt automatisch die benötigten Konfigurationsdateien (storagecontext.json, secret.txt) im temporären Testverzeichnis.

## Verwendung

```bash
# Standard-Test mit alpine-packages auf pve1.cluster
./run-live-test.sh pve1.cluster

# Spezifische Applikation testen
./run-live-test.sh pve1.cluster node-red installation
./run-live-test.sh pve1.cluster docker-compose installation

# Anderer PVE-Host
./run-live-test.sh pve2.cluster

# Container nach Test behalten (für Debugging)
KEEP_VM=1 ./run-live-test.sh pve1.cluster
```

### Argumente

1. `pve_host` - SSH-Hostname des Proxmox VE Hosts (optional, default: pve1.cluster)
2. `application` - Name der zu testenden Applikation (optional, default: alpine-packages)
3. `task` - Task-Typ (optional, default: installation)

## Was wird getestet?

1. **Container-Erstellung**
   - Container wird erfolgreich erstellt
   - VM_ID wird korrekt zurückgegeben

2. **Notes-Generierung**
   - `<!-- lxc-manager:managed -->` Marker
   - `<!-- lxc-manager:log-url ... -->` für Log-Viewer
   - `<!-- lxc-manager:icon-url ... -->` für Icons
   - `## Links` Abschnitt mit klickbaren Links

3. **Container-Status**
   - Container läuft
   - Hat Netzwerkverbindung (optional)

## Erweiterung

Das Script kann um weitere Tests erweitert werden:

```bash
# Port-Test
test_port() {
    local port=$1
    if ssh "$PVE_HOST" "pct exec $VM_ID -- nc -z localhost $port 2>/dev/null"; then
        log_ok "Port $port is listening"
    else
        log_fail "Port $port not listening"
    fi
}

# HTTP-Test
test_http() {
    local port=$1
    local path=${2:-/}
    if ssh "$PVE_HOST" "pct exec $VM_ID -- wget -q -O- http://localhost:$port$path" | grep -q .; then
        log_ok "HTTP $port$path responds"
    else
        log_fail "HTTP $port$path not responding"
    fi
}
```

## Cleanup

Container werden automatisch nach dem Test gelöscht, es sei denn `KEEP_VM=1` ist gesetzt.

Manuelles Cleanup:

```bash
ssh pve1.cluster 'pct stop <vmid>; pct destroy <vmid>'
```

Alle Test-Container löschen:

```bash
ssh pve1.cluster 'for vm in $(pct list | grep "test-" | awk "{print \$1}"); do pct stop $vm 2>/dev/null; pct destroy $vm; done'
```
