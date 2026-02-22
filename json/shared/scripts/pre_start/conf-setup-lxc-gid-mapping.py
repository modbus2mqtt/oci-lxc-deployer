#!/usr/bin/env python3
"""Setup GID mapping for unprivileged LXC containers.

This script configures /etc/subgid and updates the container config with
`lxc.idmap` entries for GIDs only (kind: `g`). It preserves any existing UID
idmap entries.

Parameters:
  - gid: Group ID(s) for 1:1 mapping (e.g., "1000" or "1000,1001")
  - uid: User ID - used as fallback if gid is not set (e.g., "1000")
  - vm_id: LXC container ID (optional, for updating container config)

Note: If gid is not provided or is "0", uid will be used as the default gid.
This simplifies configuration when uid and gid should be the same.

Mock paths for testing:
  - MOCK_SUBGID_PATH: Override /etc/subgid path
  - MOCK_CONFIG_DIR: Override /etc/pve/lxc directory

Output: JSON to stdout with mapped_gid (errors to stderr)
    [{"id": "mapped_gid", "value": "101000"}]
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


def main() -> None:
    gid_str = "{{ gid }}"
    uid_str = "{{ uid }}"
    vm_id = "{{ vm_id }}"

    subgid_path = os.environ.get("MOCK_SUBGID_PATH", "/etc/subgid")
    config_dir = os.environ.get("MOCK_CONFIG_DIR", "/etc/pve/lxc")

    # Use uid as fallback if gid is not set
    if not gid_str or gid_str == "NOT_DEFINED" or gid_str.strip() == "" or gid_str.strip() == "0":
        if uid_str and uid_str != "NOT_DEFINED" and uid_str.strip() != "" and uid_str.strip() != "0":
            gid_str = uid_str
            eprint(f"setup-lxc-gid-mapping: gid not set, using uid={uid_str} as fallback")
        else:
            gid_str = "0"

    eprint(f"setup-lxc-gid-mapping: vm_id={vm_id!r} gid={gid_str!r} uid={uid_str!r} subgid_path={subgid_path} config_dir={config_dir}")
    if not vm_id or vm_id == "NOT_DEFINED" or vm_id.strip() == "":
        vm_id = ""

    gid_list = parse_ids(gid_str)
    if not gid_list:
        eprint("setup-lxc-gid-mapping: no GID mapping requested (gid is empty/0) -> skipping /etc/subgid and lxc.idmap updates")
        return

    eprint(f"setup-lxc-gid-mapping: requested GIDs for 1:1 mapping: {gid_list}")

    update_file(subgid_path, calculate_subid_entries(gid_list))
    eprint(f"setup-lxc-gid-mapping: ensured /etc/subgid entries for {len(gid_list)} GID(s)")

    config_lines: List[str] = []
    config_path: Path | None = None
    if vm_id and vm_id.isdigit():
        config_path = Path(config_dir) / f"{vm_id}.conf"
        idmap_entries = calculate_idmap_entries(gid_list, "g")
        if idmap_entries:
            update_lxc_config_kind(config_path, "g", idmap_entries)
            eprint(f"setup-lxc-gid-mapping: updated {config_path} with {len(idmap_entries)} GID idmap line(s)")
        try:
            config_lines = config_path.read_text(encoding="utf-8").splitlines(True)
        except Exception:
            config_lines = []
    else:
        if vm_id:
            eprint("setup-lxc-gid-mapping: vm_id is not numeric; skipping lxc config updates")
        else:
            eprint("setup-lxc-gid-mapping: vm_id not provided; skipping lxc config updates")

    unprivileged = detect_unprivileged_from_config(config_lines)

    g_segments = parse_idmap_lines(config_lines, "g") if config_lines else []
    if not g_segments and unprivileged:
        g_segments = [(0, STANDARD_START, 65536)]

    mapped_gid_val = compute_host_id_for_container_id(gid_list[0], g_segments, unprivileged)
    eprint(f"setup-lxc-gid-mapping: mapped_gid for container gid {gid_list[0]} -> host gid {mapped_gid_val}")
    print(json.dumps([{"id": "mapped_gid", "value": str(mapped_gid_val)}]))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
