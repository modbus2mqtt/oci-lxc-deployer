#!/usr/bin/env python3
"""List managed OCI containers from Proxmox LXC config files.

Scans `${LXC_MANAGER_PVE_LXC_DIR:-/etc/pve/lxc}/*.conf` (env override supported for tests)
for containers that:
- contain the lxc-manager managed marker
- contain an OCI image marker or visible OCI image line

Outputs a single VeExecution output id `containers` whose value is a JSON string
representing an array of objects: { vm_id, hostname?, oci_image, icon: "" }.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path


MANAGED_RE = re.compile(r"lxc-manager:managed", re.IGNORECASE)
OCI_MARKER_RE = re.compile(r"lxc-manager:oci-image\s+(.+?)\s*-->", re.IGNORECASE)
OCI_VISIBLE_RE = re.compile(r"^\s*OCI image:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
HOSTNAME_RE = re.compile(r"^hostname:\s*(.+?)\s*$", re.MULTILINE)


def _extract_oci_image(conf_text: str) -> str | None:
    m = OCI_MARKER_RE.search(conf_text)
    if m:
        val = m.group(1).strip()
        return val or None
    m2 = OCI_VISIBLE_RE.search(conf_text)
    if m2:
        val = m2.group(1).strip()
        return val or None
    return None


def _extract_hostname(conf_text: str) -> str | None:
    m = HOSTNAME_RE.search(conf_text)
    if not m:
        return None
    val = m.group(1).strip()
    return val or None


def main() -> None:
    base_dir = Path(os.environ.get("LXC_MANAGER_PVE_LXC_DIR", "/etc/pve/lxc"))

    containers: list[dict] = []

    if base_dir.is_dir():
        # Stable order by vmid
        for conf_path in sorted(base_dir.glob("*.conf"), key=lambda p: p.name):
            vmid_str = conf_path.stem
            if not vmid_str.isdigit():
                continue

            try:
                conf_text = conf_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue

            # Proxmox LXC config "description:" lines often encode newlines as literal "\\n".
            # Normalize so regexes that expect line starts (MULTILINE) work reliably.
            conf_text = conf_text.replace("\\n", "\n")

            if not MANAGED_RE.search(conf_text):
                continue

            oci_image = _extract_oci_image(conf_text)
            if not oci_image:
                continue

            hostname = _extract_hostname(conf_text)

            item = {
                "vm_id": int(vmid_str),
                "oci_image": oci_image,
                "icon": "",
            }
            if hostname:
                item["hostname"] = hostname

            containers.append(item)

    # Return output in VeExecution format: IOutput[]
    print(json.dumps([{"id": "containers", "value": json.dumps(containers)}]))


if __name__ == "__main__":
    main()
