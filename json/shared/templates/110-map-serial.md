# Map Serial Device (110)

Diese Vorlage mappt ein Serial-/USB-Serial-Gerät vom Proxmox-Host in einen LXC-Container.

Ziel ist eine stabile Device-Path-Story für den Container (z. B. immer `/dev/ttyUSB0`) – auch wenn das Gerät am Host nach einem Replug einen anderen `/dev/ttyUSB*`-Namen bekommt.

## Verwendung (stabil + optional live replug)

1. **`host_device_path` setzen**:
   - Wähle einen stabilen Pfad wie `/dev/serial/by-id/...` (enthält oft die USB-Seriennummer).
   - Vorteil: Mapping ist stabil über Replug hinweg (spätestens nach Container-Restart).

2. **Optional (Advanced): `Live Replug (Host-Installation)` aktivieren** (`install_replug_watcher=true`):
   - Installiert am Proxmox-Host eine **udev-Regel** + einen **systemd oneshot Service**.
   - Bei einem Replug wird das aktuell aufgelöste Device-Node automatisch erneut **in den laufenden Container gebind-mountet**.
   - Ergebnis: Replug funktioniert in der Praxis ohne Container-Restart.

Warum ist das nötig?

- Ein USB-Serial-Adapter taucht nach Replug oft als **anderes** `/dev/ttyUSBX` auf.
- Der Container sieht aber typischerweise einen **festen Zielpfad** (z. B. `/dev/ttyUSB0`), weil Anwendungen so konfiguriert werden.
- Damit dieser feste Zielpfad im **laufenden** Container wieder auf das neue Host-Device zeigt, braucht es einen **Host-Trigger**, der neu bind-mountet.

Wichtig: `install_replug_watcher=true` erfordert `host_device_path` (z. B. `/dev/serial/by-id/...`).

Nachteil / Trade-off:

- Diese Option muss **am Proxmox-Host** etwas installieren (udev-Regel + systemd Unit). Wenn du das nicht möchtest, bleibt als Alternative nur „Container neu starten nach Replug“.

## USB Serial Port

Wähle hier den USB-Serial-Adapter aus.

- Der `value` ist ein stabiler Pfad wie `/dev/serial/by-id/...`.
- Der Anzeigename ist menschenlesbar (Vendor/Model/Serial), aber entscheidend ist der `value`.

Wenn du das Feld leer lässt, wird das Serial-Mapping übersprungen.

## Live Replug (Host-Installation)

Aktiviere diese Option, wenn das Device nach einem Replug **ohne Container-Restart** weiter funktionieren soll.

Was passiert technisch?

- Auf dem Proxmox-Host wird eine udev-Regel + eine systemd oneshot Unit installiert.
- Bei jedem Replug (`ACTION=add`) wird das aktuell aufgelöste Device-Node (aus `host_device_path`) erneut in den laufenden Container gebind-mountet.
- Ziel ist immer `container_device_path` (z. B. `/dev/serial-by-id` oder für Legacy `/dev/ttyUSB0`).

Trade-off:

- Host-seitige Installation (schreibt nach `/etc/udev/rules.d` und `/etc/systemd/system`).

## ID of the VM

ID des Ziel-Containers (Proxmox CT-ID), in den das Serial-Device gemappt werden soll.

- Beispiel: `114`
- Hinweis: Dieses Mapping ist aktuell für **LXC** gedacht.

## Security-Hinweise

- `map_usb_bus_directory=true` bedeutet **deutlich breiteren Zugriff**: der Container sieht und kann (je nach Kernel-/Treiber-Situation) potentiell mit **mehreren USB-Geräten** auf dem Host interagieren.
- Für „minimalen Zugriff“ ist `host_device_path` die bessere Wahl, weil dabei nur ein konkreter Pfad in den Container gebind-mountet wird.
- In einem **unprivileged LXC** sind Dateisystem- und UID/GID-Rechte zwar stärker eingeschränkt, aber **Device-Nodes sind eine eigene Sicherheitsdomäne**. Gib daher nur die Rechte frei, die du wirklich brauchst.

## Parameter-Guide (Kurzfassung)

- `host_device_path`: Stabiler Host-Pfad, z. B. `/dev/serial/by-id/...`.
- `install_replug_watcher`: Live-Replug ohne Container-Restart (udev + systemd rebind).

## Container Device Path (`container_device_path`)

Dieses Feld steuert **nur den Zielpfad im Container**.

- **Default:** `/dev/ttyUSB0`
   - Das ist ein normaler Device-Node-Pfad, den praktisch jede App direkt öffnen kann.
   - Die Stabilität kommt vom Host-Pfad `/dev/serial/by-id/...` (Quelle) + optionalem Live-Replug.

- **Legacy-Beispiel:** `/dev/ttyUSB0`
   - Manche ältere Container/Apps erwarten hart `/dev/ttyUSB0`.
   - Setze dafür explizit: `container_device_path=/dev/ttyUSB0`.

Wichtig:

- Der Replug-Mechanismus (`install_replug_watcher`) bind-mountet nach Replug immer wieder auf **genau diesen** Zielpfad.
   - D. h. wenn du `/dev/ttyUSB0` als Ziel wählst, bleibt auch `/dev/ttyUSB0` nach Replug stabil (ohne Restart), solange der Host-Rebind aktiv ist.

## UID

- **Bedeutung**: Container-UID, die im Container Zugriff haben soll.
- **Standard**: `0` (root).
- **Unprivileged Container**: root im Container ist nicht root auf dem Host.
   Damit im Container nicht `nobody` erscheint, setzt das Script die Host-Ownership des Device-Nodes auf die gemappten Host-IDs (via `lxc.idmap` oder Proxmox-Default).

## GID

- **Bedeutung**: Container-GID für den Zugriff.
- **Standard**: `20` (typisch `dialout` auf Debian/Ubuntu; in Alpine kann die Gruppennummer abweichen).
- **Beispiel**: `gid=20` ergibt im Container effektiv `root:dialout`, sofern die Gruppe existiert.
- **Unprivileged Container**: Auch hier gilt: Script mappt/übersetzt auf passende Host-GID, damit es nicht als `nobody` endet.

## Mapped UID (Host)

Optional: explizite Host-UID, die auf dem Host für den Device-Node gesetzt wird.

- Wenn leer, wird automatisch gemappt (aus `lxc.idmap` oder Proxmox-Default `100000 + uid`).
- Nur nötig, wenn du bewusst eine spezielle ID-Mapping-Konfiguration nutzt.

## Mapped GID (Host)

Optional: explizite Host-GID, die auf dem Host für den Device-Node gesetzt wird.

- Wenn leer, wird automatisch gemappt (aus `lxc.idmap` oder Proxmox-Default `100000 + gid`).
- Nur nötig, wenn du bewusst eine spezielle ID-Mapping-Konfiguration nutzt.

## Container Device Path

Der Zielpfad im Container, auf den gebind-mountet wird.

- **Default:** `/dev/ttyUSB0`
- Typisch für Apps/Services, die einfach einen festen Port-Pfad brauchen.
- Für mehrere Adapter solltest du pro Adapter einen eigenen Zielpfad wählen (z. B. `/dev/ttyUSB0`, `/dev/ttyUSB1`, ...).
