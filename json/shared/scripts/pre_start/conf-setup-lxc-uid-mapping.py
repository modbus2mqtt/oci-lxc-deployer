#!/usr/bin/env python3
"""Setup UID mapping for unprivileged LXC containers.

This script configures /etc/subuid and updates the container config with
`lxc.idmap` entries for UIDs only (kind: `u`). It preserves any existing GID
idmap entries.

Parameters:
    - uid: User ID(s) for 1:1 mapping (e.g., "1000" or "1000,1001")
    - vm_id: LXC container ID (optional, for updating container config)

Mock paths for testing:
    - MOCK_SUBUID_PATH: Override /etc/subuid path
    - MOCK_CONFIG_DIR: Override /etc/pve/lxc directory

Output: JSON to stdout with mapped_uid (errors to stderr)
        [{"id": "mapped_uid", "value": "101000"}]
"""

import json
import os
import sys
from pathlib import Path
from typing import List


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)

# NOTE: This script is often executed via stdin with `setup_lxc_idmap_common.py`
# prepended (library-style). For standalone execution and better static analysis,
# we also try to import the helpers from the filesystem.
try:
    from setup_lxc_idmap_common import (  # type: ignore
        STANDARD_START,
        calculate_idmap_entries,
        calculate_subid_entries,
        compute_host_id_for_container_id,
        detect_unprivileged_from_config,
        parse_idmap_lines,
        parse_ids,
        update_file,
        update_lxc_config_kind,
    )
except Exception:
    # If the module isn't available as a file, we expect it to be prepended.
    pass

def main():
    # Get parameters from template variables (will be replaced by sed during script download)
    uid_str = "{{ uid }}"
    vm_id = "{{ vm_id }}"
    
    # Mock paths for testing (still supported via environment variables)
    subuid_path = os.environ.get('MOCK_SUBUID_PATH', '/etc/subuid')
    config_dir = os.environ.get('MOCK_CONFIG_DIR', '/etc/pve/lxc')

    eprint(f"setup-lxc-uid-mapping: vm_id={vm_id!r} uid={uid_str!r} subuid_path={subuid_path} config_dir={config_dir}")
    
    # Normalize parameters (empty/NOT_DEFINED means not set)
    if not uid_str or uid_str == "NOT_DEFINED" or uid_str.strip() == "":
        uid_str = "0"
    if not vm_id or vm_id == "NOT_DEFINED" or vm_id.strip() == "":
        vm_id = ""

    uid_list = parse_ids(uid_str)
    if not uid_list:
        eprint("setup-lxc-uid-mapping: no UID mapping requested (uid is empty/0) -> skipping /etc/subuid and lxc.idmap updates")
        return

    eprint(f"setup-lxc-uid-mapping: requested UIDs for 1:1 mapping: {uid_list}")
    update_file(subuid_path, calculate_subid_entries(uid_list))
    eprint(f"setup-lxc-uid-mapping: ensured /etc/subuid entries for {len(uid_list)} UID(s)")

    # Default: assume unprivileged unless config says otherwise
    config_lines: List[str] = []
    config_path: Path | None = None
    if vm_id and vm_id.isdigit():
        config_path = Path(config_dir) / f"{vm_id}.conf"
        idmap_entries = calculate_idmap_entries(uid_list, "u")
        if idmap_entries:
            update_lxc_config_kind(config_path, "u", idmap_entries)
            eprint(f"setup-lxc-uid-mapping: updated {config_path} with {len(idmap_entries)} UID idmap line(s)")
        try:
            config_lines = config_path.read_text(encoding="utf-8").splitlines(True)
        except Exception:
            config_lines = []
    else:
        if vm_id:
            eprint("setup-lxc-uid-mapping: vm_id is not numeric; skipping lxc config updates")
        else:
            eprint("setup-lxc-uid-mapping: vm_id not provided; skipping lxc config updates")

    unprivileged = detect_unprivileged_from_config(config_lines)

    u_segments = parse_idmap_lines(config_lines, "u") if config_lines else []
    if not u_segments and unprivileged:
        u_segments = [(0, STANDARD_START, 65536)]

    mapped_uid_val = compute_host_id_for_container_id(uid_list[0], u_segments, unprivileged)
    eprint(f"setup-lxc-uid-mapping: mapped_uid for container uid {uid_list[0]} -> host uid {mapped_uid_val}")
    print(json.dumps([{"id": "mapped_uid", "value": str(mapped_uid_val)}]))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
