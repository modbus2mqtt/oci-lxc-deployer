#!/usr/bin/env python3
"""Shared helpers for Proxmox/LXC unprivileged UID/GID mapping.

Designed to be *prepended* to other Python scripts and executed via stdin.
Therefore it must not rely on package imports from the filesystem.
"""

import os
from pathlib import Path
from typing import Iterable, List, Tuple

STANDARD_START = 100000
STANDARD_COUNT = 65536


def parse_ids(id_str: str) -> List[int]:
    """Parse comma-separated IDs into sorted unique list of integers.

    Treats "0" or empty as "not set".
    """

    if not id_str or id_str.strip() == "" or id_str.strip() == "0":
        return []
    return sorted({int(x.strip()) for x in id_str.split(",") if x.strip()})


def _calculate_specific_and_rest_ranges(max_id: int) -> tuple[int, int, int]:
    """Return (specific_start, rest_start, rest_count) for the given max_id."""

    specific_start = STANDARD_START + STANDARD_COUNT + ((max_id // 10) * STANDARD_COUNT)
    rest_start = specific_start + max_id + 1
    rest_count = 65536 - max_id - 1
    return specific_start, rest_start, rest_count


def calculate_subid_entries(ids: Iterable[int]) -> List[str]:
    ids_list = sorted(set(ids))
    if not ids_list:
        return []

    max_id = max(ids_list)
    specific_start, rest_start, rest_count = _calculate_specific_and_rest_ranges(max_id)

    entries: List[str] = [
        f"root:{STANDARD_START}:{STANDARD_COUNT}",
        f"root:{specific_start}:{max_id}",
    ]

    for value in ids_list:
        entries.append(f"root:{value}:1")

    entries.append(f"root:{rest_start}:{rest_count}")
    return entries


def calculate_idmap_entries(ids: Iterable[int], kind: str) -> List[str]:
    """Create lxc.idmap entries for one kind ('u' or 'g')"""

    if kind not in ("u", "g"):
        raise ValueError("kind must be 'u' or 'g'")

    ids_list = sorted(set(ids))
    if not ids_list:
        return []

    max_id = max(ids_list)
    specific_start, rest_start, rest_count = _calculate_specific_and_rest_ranges(max_id)

    idmap_entries: List[str] = []

    first_id = min(ids_list)
    if first_id > 0:
        idmap_entries.append(f"lxc.idmap: {kind} 0 {STANDARD_START} {first_id}")

    for value in ids_list:
        idmap_entries.append(f"lxc.idmap: {kind} {value} {value} 1")

    last_id = max_id
    if last_id < 65535:
        idmap_entries.append(f"lxc.idmap: {kind} {last_id + 1} {rest_start} {rest_count}")

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
