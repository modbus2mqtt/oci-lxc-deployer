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
        [{"id": "mapped_uid", "value": "1000"}]
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


def main():
    uid_str = "{{ uid }}"
    vm_id = "{{ vm_id }}"

    subuid_path = os.environ.get('MOCK_SUBUID_PATH', '/etc/subuid')
    config_dir = os.environ.get('MOCK_CONFIG_DIR', '/etc/pve/lxc')

    print(f"setup-lxc-uid-mapping: vm_id={vm_id!r} uid={uid_str!r} subuid_path={subuid_path} config_dir={config_dir}", file=sys.stderr)

    if not uid_str or uid_str == "NOT_DEFINED" or uid_str.strip() == "":
        uid_str = "0"

    setup_idmap(
        kind="u",
        id_str=uid_str,
        vm_id=vm_id,
        sub_file_path=subuid_path,
        config_dir=config_dir,
        log_prefix="setup-lxc-uid-mapping",
    )


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
