# Proxmox 9.1 – OCI→LXC: USB-Mapping (fixe GID) & User-Ermittlung (Start/Stop)

Ziel dieses Dokuments ist es, zwei pragmatische Lösungen zu skizzieren, die wir im Projekt wiederverwenden können:

1. USB/Serial Device Mapping in LXC über eine **fixe, image-unabhängige numerische GID**.
2. Ermittlung der **tatsächlichen Runtime-UID/GID** eines OCI-Images durch **kurzes Starten → UID/GID auslesen → Stoppen → Mapping setzen**.

Kontext im Repo:
- USB/Serial Mapping: `json/shared/scripts/map-serial-device.sh` (ohne Replug-Handler; permissions-orientiert)
- UID Mapping/Idmap: `json/shared/scripts/setup-lxc-uid-mapping.py` (+ gemeinsame Library `json/shared/scripts/setup_lxc_idmap_common.py`)
- GID Mapping/Idmap: `json/shared/scripts/setup-lxc-gid-mapping.py` (+ gemeinsame Library `json/shared/scripts/setup_lxc_idmap_common.py`)


## Hintergrund / Randbedingungen

### Proxmox LXC Config wird nicht “live” neu geladen
Änderungen an `/etc/pve/lxc/<VMID>.conf` wirken i.d.R. **erst nach einem Container-Restart** (mindestens Stop/Start), weil LXC die Config beim Start einliest.

### “Dynamische” / unbekannte User im OCI Image
Bei OCI Images ist der effektive Runtime-User nicht zuverlässig aus einem „Base Image“ ableitbar:
- `config.User` kann leer sein (default root)
- Entrypoints können User wechseln (z.B. via `gosu`, `su-exec`, `su`, `runuser`)
- Manche Images erzeugen User/Gruppen dynamisch beim Start

Daher ist die einzige robuste Methode für „Wer läuft wirklich?“ häufig: **Container starten und den laufenden Prozess inspizieren**.


## Lösung 1: USB-Mapping über dialout(20) + 1:1 GID-Mapping

### Ziel
Wir wollen USB/Serial Zugriff so konfigurieren, dass:
- wir den Namen der Gruppe im OCI Image **nicht** kennen müssen (wir erzwingen numerisch `20`),
- wir ohne Host-udev-Sonderlogik auskommen,
- das Ganze bei **unprivileged** LXC nachvollziehbar bleibt.

### Grundidee
Wir verwenden die **Debian-Standardgruppe `dialout` mit GID 20** als feste numerische Container-GID.

Wichtig: Damit das ohne udev-Regel funktioniert, muss GID 20 per `lxc.idmap` **1:1** gemappt werden.

- Im Container sorgen wir dafür, dass es eine Gruppe mit **GID 20** gibt (Name ist egal, typischerweise `dialout`) und der Service-User Mitglied ist.
- Auf dem Host verlassen wir uns auf das Standardverhalten (Proxmox/Debian): `/dev/ttyUSB*` gehört i.d.R. zur Gruppe `dialout` (GID 20) und ist für Gruppen les-/schreibbar.

### Warum 1:1 Mapping hier entscheidend ist
Wenn der Container unprivileged ist und **kein** 1:1 `lxc.idmap` existiert, gilt typischerweise (Default Proxmox):

- Container-GID $g$ → Host-GID $100000 + g$

Für `g=20` wäre das Host-GID `100020`.

Damit der Container-Prozess wirklich mit Host-GID `20` auf ein `root:dialout(20)` Device zugreifen darf, muss `g 20 20 1` explizit gemappt werden.

### Was muss im Container passieren? (einmalig nach erstem Start)
Im Container:

```sh
getent group 20 >/dev/null 2>&1 || groupadd -g 20 dialout || true
usermod -aG 20 <service-user> || usermod -aG dialout <service-user>
# optional:
# id <service-user>
```

Hinweis: Wenn das Image dynamisch User/Groups verwaltet, muss dieser Schritt ggf. in einen „First-boot“/Init-Schritt.

### Was muss auf dem Host passieren?
Im Normalfall (Proxmox/Debian) **nichts zusätzlich**.

Voraussetzung ist, dass der Host die Device-Nodes für USB-Serial so anlegt, dass `dialout` Zugriff hat (typisch: `root:dialout` + `0660/0664`).

Wenn das auf deinem Host nicht zutrifft (seltene Sonderkonfiguration), ist das kein Container-Thema, sondern Host-udev/Permissions. Dann muss man hostseitig korrigieren.

### Einbau in unsere Scripts (geplantes Verhalten)

#### Parameter/Defaults
`map-serial-device.sh` arbeitet mit `uid`/`gid` und optional `mapped_uid`/`mapped_gid`.

Baseline:
- `uid` default: `0`
- `gid` default: `20` (dialout)

Wir nutzen `mapped_uid/mapped_gid` nur, wenn wir auf Host-Seite tatsächlich abweichende IDs brauchen.

Empfehlung:
- **Fixe GID** als Default ist der wichtigste Teil (USB-Rechte laufen meist über Gruppe).
- UID kann optional weiterhin 1000 bleiben, wenn nur Gruppenzugriff gebraucht wird.

#### Was NICHT mehr passieren sollte
- Keine udev-Regeln/Ownership-Manipulation als Standardlösung.
- Kein Replug-Handler, der die Proxmox-Config ständig umschreibt.

#### Device-Pfad stabilisieren
Statt instabiler Bus/Device-Kombinationen bevorzugen:
- `/dev/serial/by-id/...` (bei USB-Serial)


## Lösung 2: OCI Runtime-User ermitteln via Start → Inspect → Stop

### Ziel
Wenn wir die tatsächliche UID/GID eines gestarteten OCI→LXC Containers für Mapping benötigen (z.B. Ownership von Mounts, USB-Devices, etc.), dann ist die zuverlässigste Variante:

1. Container erzeugen/starten.
2. UID/GID des relevanten Prozesses auslesen.
3. Container stoppen.
4. `lxc.idmap` / subuid/subgid setzen.
5. Container final starten.

### Minimaler Inspect (robust, ohne "ps")
Im Container (oder via `pct exec`):

```sh
awk '/^Uid:|^Gid:/{print}' /proc/1/status
```

Das liefert die numerischen IDs von PID 1.

Hinweis: PID 1 kann ein Wrapper sein. Wenn möglich zusätzlich:
- `ps -eo pid,uid,gid,args | head` (falls `ps` vorhanden)

### Host-seitige Automatisierung (Skizze)
Pseudo-Ablauf:

1) `pct start <VMID>`
2) `pct exec <VMID> -- awk '/^Uid:|^Gid:/{print}' /proc/1/status`
3) Werte parsen → `uid`, `gid`
4) `pct stop <VMID>`
5) Mapping anwenden:
   - `/etc/subuid`/`/etc/subgid` ergänzen (Host)
   - `lxc.idmap` in `/etc/pve/lxc/<VMID>.conf`
6) `pct start <VMID>`

### Wo das in unsere Umsetzung passt
Wir nutzen den Start/Stop/Start Ablauf sowieso (Runtime-User ermitteln). In diesem Zuge setzen wir:
- UID-Mapping via `setup-lxc-uid-mapping.py`
- GID-Mapping via `setup-lxc-gid-mapping.py`

Danach (beim finalen Start / First-Boot) legen wir im Container die Gruppe GID 20 an (falls nötig) und nehmen den Service-User in diese Gruppe auf.


## Hinweise / Fallstricke

- **Config-Änderungen brauchen Restart**: idmap und `dev0`/cgroup allow werden erst beim Start wirksam.
- **Unprivileged Default Offset** ist oft `100000`, aber nicht garantiert, wenn custom `lxc.idmap` existiert.
- **Replug**: Wenn Host-udev ohnehin `root:dialout` setzt und GID 20 1:1 gemappt ist, bleiben Rechte auch nach Replug korrekt.
- **Stabile Device-Namen** bevorzugen, sonst wird Mapping fragile.


## Nächste Schritte (wenn wir weiter automatisieren wollen)

1) Start/Inspect/Stop Helper-Logik implementieren (neues Script oder Erweiterung), die UID/GID aus `/proc/1/status` ermittelt und dann `setup-lxc-uid-mapping.py` + `setup-lxc-gid-mapping.py` nutzt.
2) First-Boot Schritt definieren, der im Container die Gruppe GID 20 sicherstellt und den Service-User in diese Gruppe aufnimmt.
