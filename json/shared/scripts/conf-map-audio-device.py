#!/usr/bin/env python3
"""Map audio device to LXC container.

Executed via stdin with map_device_lib.py prepended.

Migration goal:
- Avoid heredoc-generated helper scripts.
- Support replug for unprivileged containers by mapping /dev/snd + using a minimal udev
    permissions rule (MODE=0666) for USB audio devices.
"""

import os
import re

# Optional import for editor/type checking; at runtime this script is executed with the
# library code prepended via stdin.
try:
    from map_device_lib import *  # type: ignore
except Exception:
    pass


from typing import Optional, Tuple


def _best_effort_usb_ids_for_audio_card(card_number: int) -> Tuple[Optional[str], Optional[str]]:
    # udev properties are usually present on control node for USB audio.
    control = f"/dev/snd/controlC{card_number}"
    if not os.path.exists(control):
        return None, None
    return find_usb_ids_for_devnode(control)


def main() -> int:
    require_root()

    audio_card = "{{ audio_card }}".strip()
    if not audio_card:
        eprint("Error: audio_card is required (card0, card1, ...)")
        return 1

    vm_id = "{{ vm_id }}".strip()
    if not vm_id:
        eprint("Error: vm_id is required")
        return 1

    m = re.fullmatch(r"card(\d+)", audio_card)
    if not m:
        eprint("Error: Invalid audio_card format. Expected card0, card1, ...")
        return 1

    card_number = int(m.group(1))
    if not os.path.exists(f"/sys/class/sound/{audio_card}"):
        eprint(f"Error: Audio card {audio_card} does not exist")
        return 1

    uid = tmpl_int("{{ uid }}", 0)
    gid = tmpl_int("{{ gid }}", 0)

    vm_type = detect_vm_type(vm_id)
    if vm_type == "unknown":
        eprint(f"Error: VM/Container {vm_id} does not exist")
        return 1

    if vm_type != "lxc":
        eprint("Error: map-audio-device.py currently supports LXC only")
        return 1

    if not check_vm_stopped(vm_id, vm_type):
        eprint(f"Error: Container {vm_id} is running. Please stop it before mapping audio devices.")
        return 1

    config_file = f"/etc/pve/lxc/{vm_id}.conf"

    try:
        config = read_text(config_file)
    except Exception as ex:
        eprint(f"Error: Cannot read {config_file}: {ex}")
        return 1

    # Remove existing /dev/snd directory mounts to keep idempotent
    config = remove_lines_matching(
        config,
        [
            re.compile(r"^lxc\\.mount\\.entry\\s*=\\s*/dev/snd\\s+dev/snd\\s+.*$"),
        ],
    )

    # Allow ALSA device major (usually 116) and bind-mount /dev/snd.
    # This makes replug work without needing to rewrite LXC config entries.
    config = ensure_line(config, "lxc.cgroup2.devices.allow = c 116:* rwm")
    config = ensure_line(config, "lxc.mount.entry = /dev/snd dev/snd none bind,optional,create=dir")

    write_text_atomic(config_file, config)

    vendor, model = _best_effort_usb_ids_for_audio_card(card_number)
    if vendor and model and shutil_which("udevadm"):
        rule_path = f"/etc/udev/rules.d/99-lxc-audio-perms-{vm_id}-{vendor}-{model}.rules"
        # Keep rule minimal: permissions only, no RUN scripts.
        # ATTRS matches work across child nodes (sound devices inherit usb parent attributes).
        rule = (
            f'SUBSYSTEM=="sound", ATTRS{{idVendor}}=="{vendor}", ATTRS{{idProduct}}=="{model}", MODE="0666"\n'
        )
        write_text_atomic(rule_path, rule, mode=0o644)
        udev_reload_rules()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
