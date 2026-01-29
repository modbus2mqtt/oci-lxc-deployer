#!/usr/bin/env python3
"""List managed OCI containers from Proxmox LXC config files.

Scans `${LXC_MANAGER_PVE_LXC_DIR:-/etc/pve/lxc}/*.conf` (env override supported for tests)
for containers that:
- contain the oci-lxc-deployer managed marker
- contain an OCI image marker or visible OCI image line

Outputs a single VeExecution output id `containers` whose value is a JSON string
representing an array of objects: { vm_id, hostname?, oci_image, icon: "" }.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import unquote


MANAGED_RE = re.compile(r"(?:oci-lxc-deployer):managed", re.IGNORECASE)
OCI_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):oci-image\s+(.+?)\s*-->", re.IGNORECASE)
OCI_VISIBLE_RE = re.compile(r"^\s*OCI image:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
HOSTNAME_RE = re.compile(r"^hostname:\s*(.+?)\s*$", re.MULTILINE)
APP_ID_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):application-id\s+(.+?)\s*-->", re.IGNORECASE)
APP_NAME_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):application-name\s+(.+?)\s*-->", re.IGNORECASE)
APP_ID_VISIBLE_RE = re.compile(r"^\s*#?\s*Application\s+ID\s*:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
APP_NAME_VISIBLE_RE = re.compile(r"^\s*#?\s*##\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
VERSION_VISIBLE_RE = re.compile(r"^\s*#?\s*Version\s*:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)


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


def _extract_from_patterns(conf_text: str, patterns: list[re.Pattern[str]]) -> str | None:
    for pattern in patterns:
        m = pattern.search(conf_text)
        if m:
            val = m.group(1).strip()
            if val:
                return val
    return None


def get_status(vmid: int) -> str | None:
    try:
        result = subprocess.run(
            ["pct", "status", str(vmid)],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return None
        out = result.stdout.strip()
        # Expected format: "status: running" or "status: stopped"
        if "status:" in out:
            return out.split("status:", 1)[1].strip() or None
        return out or None
    except Exception:
        return None


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
            decoded_text = unquote(conf_text)

            if not MANAGED_RE.search(conf_text) and not MANAGED_RE.search(decoded_text):
                continue

            oci_image = _extract_oci_image(decoded_text) or _extract_oci_image(conf_text)
            if not oci_image:
                continue

            hostname = _extract_hostname(decoded_text) or _extract_hostname(conf_text)
            application_id = _extract_from_patterns(decoded_text, [APP_ID_MARKER_RE, APP_ID_VISIBLE_RE]) or _extract_from_patterns(
                conf_text,
                [APP_ID_MARKER_RE, APP_ID_VISIBLE_RE],
            )
            application_name = _extract_from_patterns(decoded_text, [APP_NAME_MARKER_RE, APP_NAME_VISIBLE_RE]) or _extract_from_patterns(
                conf_text,
                [APP_NAME_MARKER_RE, APP_NAME_VISIBLE_RE],
            )
            version = _extract_from_patterns(decoded_text, [VERSION_VISIBLE_RE]) or _extract_from_patterns(
                conf_text,
                [VERSION_VISIBLE_RE],
            )

            item = {
                "vm_id": int(vmid_str),
                "oci_image": oci_image,
                "icon": "",
            }
            if hostname:
                item["hostname"] = hostname
            if application_id:
                item["application_id"] = application_id
            if application_name:
                item["application_name"] = application_name
            if version:
                item["version"] = version

            containers.append(item)

    if containers:
        max_workers = min(8, len(containers))
        vmids = [item["vm_id"] for item in containers]
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            statuses = list(executor.map(get_status, vmids))
        for item, status in zip(containers, statuses):
            if status:
                item["status"] = status

    # Return output in VeExecution format: IOutput[]
    print(json.dumps([{"id": "containers", "value": json.dumps(containers)}]))


if __name__ == "__main__":
    main()
