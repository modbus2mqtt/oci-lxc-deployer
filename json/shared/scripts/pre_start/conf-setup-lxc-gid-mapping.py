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
    [{"id": "mapped_gid", "value": "1000"}]
"""

import os
import sys

# NOTE: This script is executed via stdin with `setup_lxc_idmap_common.py`
# prepended (library-style). For standalone execution and better static analysis,
# we also try to import the orchestration function from the filesystem.
try:
    from setup_lxc_idmap_common import setup_idmap  # type: ignore
except Exception:
    pass


def main() -> None:
    gid_str = "{{ gid }}"
    uid_str = "{{ uid }}"
    vm_id = "{{ vm_id }}"

    subgid_path = os.environ.get("MOCK_SUBGID_PATH", "/etc/subgid")
    config_dir = os.environ.get("MOCK_CONFIG_DIR", "/etc/pve/lxc")

    # GID-specific fallback: use uid as gid if gid is not set
    if not gid_str or gid_str == "NOT_DEFINED" or gid_str.strip() == "" or gid_str.strip() == "0":
        if uid_str and uid_str != "NOT_DEFINED" and uid_str.strip() != "" and uid_str.strip() != "0":
            gid_str = uid_str
            print(f"setup-lxc-gid-mapping: gid not set, using uid={uid_str} as fallback", file=sys.stderr)
        else:
            gid_str = "0"

    print(f"setup-lxc-gid-mapping: vm_id={vm_id!r} gid={gid_str!r} uid={uid_str!r} subgid_path={subgid_path} config_dir={config_dir}", file=sys.stderr)

    setup_idmap(
        kind="g",
        id_str=gid_str,
        vm_id=vm_id,
        sub_file_path=subgid_path,
        config_dir=config_dir,
        log_prefix="setup-lxc-gid-mapping",
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
