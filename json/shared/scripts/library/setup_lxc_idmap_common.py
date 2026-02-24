#!/usr/bin/env python3
"""Shared helpers for Proxmox/LXC unprivileged UID/GID mapping.

Designed to be *prepended* to other Python scripts and executed via stdin.
Therefore it must not rely on package imports from the filesystem.
"""

import json
import os
import sys
from pathlib import Path
from typing import Iterable, List, Tuple

STANDARD_START = 100000
STANDARD_COUNT = 65536


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def parse_ids(id_str: str) -> List[int]:
    """Parse comma-separated IDs into sorted unique list of integers.

    Treats "0" or empty as "not set".
    """

    if not id_str or id_str.strip() == "" or id_str.strip() == "0":
        return []
    return sorted({int(x.strip()) for x in id_str.split(",") if x.strip()})



def calculate_subid_entries(ids: Iterable[int]) -> List[str]:
    """Calculate /etc/subuid or /etc/subgid entries needed for the given IDs.

    Returns entries for:
    - Standard subordinate range (100000:65536) for shifted mappings
    - Individual 1:1 passthrough entries for each requested ID
    """
    ids_list = sorted(set(ids))
    if not ids_list:
        return []

    entries: List[str] = [
        f"root:{STANDARD_START}:{STANDARD_COUNT}",  # Standard range for shifted IDs
    ]

    # Add 1:1 passthrough entries for each requested ID
    for value in ids_list:
        entries.append(f"root:{value}:1")

    return entries


def calculate_idmap_entries(ids: Iterable[int], kind: str) -> List[str]:
    """Create lxc.idmap entries for one kind ('u' or 'g').

    Creates a complete mapping covering all container IDs 0-65535:
    - Shifted ranges map to host IDs starting at STANDARD_START (100000)
    - Passthrough IDs map 1:1 (container ID = host ID)

    Example for IDs [1000, 2000]:
    - Container 0-999 → Host 100000-100999 (shifted)
    - Container 1000 → Host 1000 (passthrough)
    - Container 1001-1999 → Host 101000-101999 (shifted)
    - Container 2000 → Host 2000 (passthrough)
    - Container 2001-65535 → Host 102000-... (shifted)
    """
    if kind not in ("u", "g"):
        raise ValueError("kind must be 'u' or 'g'")

    ids_list = sorted(set(ids))
    if not ids_list:
        return []

    idmap_entries: List[str] = []
    host_offset = STANDARD_START  # Start of shifted range on host

    current_container_id = 0
    for passthrough_id in ids_list:
        # Add shifted range before this passthrough ID (if any gap exists)
        if current_container_id < passthrough_id:
            count = passthrough_id - current_container_id
            idmap_entries.append(f"lxc.idmap: {kind} {current_container_id} {host_offset} {count}")
            host_offset += count

        # Add 1:1 passthrough for this ID
        idmap_entries.append(f"lxc.idmap: {kind} {passthrough_id} {passthrough_id} 1")
        current_container_id = passthrough_id + 1

    # Add remaining shifted range after last passthrough ID
    if current_container_id <= 65535:
        count = 65536 - current_container_id
        idmap_entries.append(f"lxc.idmap: {kind} {current_container_id} {host_offset} {count}")

    return idmap_entries


def update_file(filepath: str, entries: List[str]) -> None:
    """Append missing entries to a text file (idempotent)."""

    Path(filepath).parent.mkdir(parents=True, exist_ok=True)

    existing = set()
    if os.path.exists(filepath):
        with open(filepath, "r", encoding="utf-8") as file_handle:
            existing = {line.strip() for line in file_handle if line.strip()}

    with open(filepath, "a", encoding="utf-8") as file_handle:
        for entry in entries:
            if entry not in existing:
                file_handle.write(entry + "\n")


def update_lxc_config_kind(config_path: Path, kind: str, idmap_entries: List[str]) -> None:
    """Update Proxmox LXC config file by replacing only the lxc.idmap lines of one kind.

    Keeps non-idmap entries and idmap entries of the other kind.
    """

    if kind not in ("u", "g"):
        raise ValueError("kind must be 'u' or 'g'")

    config_path.parent.mkdir(parents=True, exist_ok=True)

    if not config_path.exists():
        config_path.write_text("", encoding="utf-8")

    with open(config_path, "r", encoding="utf-8") as file_handle:
        lines = file_handle.readlines()

    def is_target_idmap_line(line: str) -> bool:
        s = line.strip()
        if not s.startswith("lxc.idmap"):
            return False
        parts = s.replace("=", ":").split()
        # Expected: lxc.idmap: u 0 100000 65536
        # parts[0] startswith lxc.idmap
        if len(parts) < 3:
            return False
        return parts[1] == kind

    lines = [line for line in lines if not is_target_idmap_line(line)]

    # Append entries at end (consistent with previous script behavior)
    for entry in idmap_entries:
        lines.append(entry + "\n")

    with open(config_path, "w", encoding="utf-8") as file_handle:
        file_handle.writelines(lines)


def parse_idmap_lines(lines: List[str], kind: str) -> List[Tuple[int, int, int]]:
    """Parse lxc.idmap lines into (container_start, host_start, range) for given kind."""

    if kind not in ("u", "g"):
        raise ValueError("kind must be 'u' or 'g'")

    result: List[Tuple[int, int, int]] = []
    for line in lines:
        s = line.strip()
        if not s.startswith("lxc.idmap"):
            continue
        s = s.replace("=", ":")
        parts = [p for p in s.split() if p]
        if len(parts) < 5:
            continue
        # parts example: ['lxc.idmap:', 'u', '0', '100000', '65536']
        if parts[1] != kind:
            continue
        try:
            c_start = int(parts[2])
            h_start = int(parts[3])
            rng = int(parts[4])
        except ValueError:
            continue
        result.append((c_start, h_start, rng))

    return sorted(result, key=lambda t: t[0])


def detect_unprivileged_from_config(lines: List[str]) -> bool:
    # Default: Proxmox containers are usually unprivileged in this project
    unprivileged = True
    for line in lines:
        s = line.strip()
        if s.startswith("unprivileged"):
            val = s.split(":", 1)[-1].strip().lower()
            return val in ("1", "true", "yes")
    return unprivileged


def compute_host_id_for_container_id(container_id: int, idmap_segments: List[Tuple[int, int, int]], unprivileged: bool) -> int:
    for c_start, h_start, rng in idmap_segments:
        if c_start <= container_id < c_start + rng:
            return h_start + (container_id - c_start)
    if unprivileged:
        return STANDARD_START + container_id
    return container_id


def setup_idmap(
    kind: str,
    id_str: str,
    vm_id: str,
    sub_file_path: str,
    config_dir: str,
    log_prefix: str,
) -> None:
    """Orchestrate UID or GID mapping for an unprivileged LXC container.

    1. Parses the ID string into a list of integer IDs
    2. Updates /etc/subuid or /etc/subgid with required entries
    3. Writes lxc.idmap entries to the container config
    4. Computes and outputs the mapped host ID as JSON to stdout
    """
    if kind not in ("u", "g"):
        raise ValueError("kind must be 'u' or 'g'")

    id_label = "UID" if kind == "u" else "GID"
    id_lower = "uid" if kind == "u" else "gid"
    output_id = f"mapped_{id_lower}"

    if not vm_id or vm_id == "NOT_DEFINED" or vm_id.strip() == "":
        vm_id = ""

    id_list = parse_ids(id_str)
    if not id_list:
        eprint(f"{log_prefix}: no {id_label} mapping requested ({id_lower} is empty/0) -> skipping /etc/sub{id_lower} and lxc.idmap updates")
        return

    eprint(f"{log_prefix}: requested {id_label}s for 1:1 mapping: {id_list}")

    update_file(sub_file_path, calculate_subid_entries(id_list))
    eprint(f"{log_prefix}: ensured /etc/sub{id_lower} entries for {len(id_list)} {id_label}(s)")

    config_lines: List[str] = []
    idmap_entries: List[str] = []
    if vm_id and vm_id.isdigit():
        config_path = Path(config_dir) / f"{vm_id}.conf"
        idmap_entries = calculate_idmap_entries(id_list, kind)
        if idmap_entries:
            update_lxc_config_kind(config_path, kind, idmap_entries)
            eprint(f"{log_prefix}: updated {config_path} with {len(idmap_entries)} {id_label} idmap line(s)")
        try:
            config_lines = config_path.read_text(encoding="utf-8").splitlines(True)
        except Exception:
            config_lines = []
    else:
        if vm_id:
            eprint(f"{log_prefix}: vm_id is not numeric; skipping lxc config updates")
        else:
            eprint(f"{log_prefix}: vm_id not provided; skipping lxc config updates")

    unprivileged = detect_unprivileged_from_config(config_lines)

    # Use computed idmap entries directly to avoid pmxcfs read-after-write sync issues.
    # Reading /etc/pve/ (FUSE cluster filesystem) immediately after writing may return stale data.
    if idmap_entries:
        segments = parse_idmap_lines([e + "\n" for e in idmap_entries], kind)
    else:
        segments = parse_idmap_lines(config_lines, kind) if config_lines else []
    if not segments and unprivileged:
        segments = [(0, STANDARD_START, 65536)]

    mapped_val = compute_host_id_for_container_id(id_list[0], segments, unprivileged)
    eprint(f"{log_prefix}: {output_id} for container {id_lower} {id_list[0]} -> host {id_lower} {mapped_val}")
    print(json.dumps([{"id": output_id, "value": str(mapped_val)}]))
