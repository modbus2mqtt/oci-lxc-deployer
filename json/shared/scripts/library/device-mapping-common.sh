#!/bin/sh
# Device Mapping Migration Library
#
# Shared helpers for carrying a host *device* mapping (serial / USB-serial)
# from a source LXC container to a freshly created or cloned target container.
#
# Both the upgrade flow (fresh `pct create` + 101-conf-restore-settings) and
# the reconfigure flow (100-create-ct-clone) produce a NEW target VMID derived
# from a source VMID. A serial device mapping written by
# pre_start/conf-map-serial-device.py consists of up to three parts:
#
#   1. lxc.mount.entry:            bind-mounts the host device node into the
#                                  container (this is what makes /dev/ttyUSB0
#                                  appear at container start).
#   2. lxc.cgroup2.devices.allow:  grants the container access to the device
#                                  major number.
#   3. optional replug-watcher:    a host udev rule + systemd oneshot unit that
#                                  re-binds the device into the *running*
#                                  container after a USB hot-replug. Both the
#                                  filenames and the unit body are keyed by VMID.
#
# Parts 1+2 are raw `lxc.*` config lines. `pct clone` copies them automatically,
# but the upgrade flow's fresh `pct create` does not, and conf-restore-settings
# only migrates net0/hostname/nameserver/env/mp* — so the serial mapping is lost
# on upgrade. Part 3 is keyed by the source VMID in both paths and must be
# re-stamped for the target VMID.
#
# This library contains only function definitions and no direct execution; it
# is prepended to scripts via the template `library` property. It must not
# contain any {{ }} template variables.

# Copy device-related lxc.* lines from a source conf to a target conf.
# Idempotent: lines already present on the target (byte-identical) are skipped.
# Only lxc.mount.entry / lxc.cgroup2.devices.allow are touched — mp*/dev*/usb*
# entries are owned by the volume/bind-mount logic elsewhere and left alone.
# Args: src_conf tgt_conf
copy_device_lxc_lines() {
  _dm_src="$1"
  _dm_tgt="$2"
  [ -f "$_dm_src" ] || return 0
  [ -f "$_dm_tgt" ] || return 0

  grep -E '^lxc\.(mount\.entry|cgroup2\.devices\.allow)[:=]' "$_dm_src" 2>/dev/null | while IFS= read -r _dm_line; do
    if grep -Fxq "$_dm_line" "$_dm_tgt" 2>/dev/null; then
      continue
    fi
    printf '%s\n' "$_dm_line" >> "$_dm_tgt"
    echo "  migrated device line: $_dm_line" >&2
  done
}

# Re-stamp the optional serial replug-watcher (udev rule + systemd unit) from
# the source VMID to the target VMID, then reload udev/systemd and enable the
# new unit. No-op when the source has no watcher installed (the common case:
# install_replug_watcher was false at install time).
# Args: old_vmid new_vmid
restamp_serial_replug_watcher() {
  _dm_old="$1"
  _dm_new="$2"
  _dm_old_unit="/etc/systemd/system/lxc-serial-rebind-${_dm_old}.service"
  _dm_new_unit="/etc/systemd/system/lxc-serial-rebind-${_dm_new}.service"
  _dm_old_rule="/etc/udev/rules.d/99-lxc-serial-rebind-${_dm_old}.rules"
  _dm_new_rule="/etc/udev/rules.d/99-lxc-serial-rebind-${_dm_new}.rules"

  [ -f "$_dm_old_unit" ] || return 0

  echo "  re-stamping serial replug watcher: ${_dm_old} -> ${_dm_new}" >&2

  # The unit body keys the VMID in two anchored places (Description + VM_ID
  # env); the ExecStart only references the $VM_ID *variable* and needs no edit.
  sed -e "s|^\(Description=Rebind serial device into LXC \)${_dm_old}\$|\1${_dm_new}|" \
      -e "s|^\(Environment=VM_ID=\)${_dm_old}\$|\1${_dm_new}|" \
      "$_dm_old_unit" > "$_dm_new_unit" || {
    echo "  WARN: failed to write ${_dm_new_unit}" >&2
    rm -f "$_dm_new_unit"
    return 0
  }

  if [ -f "$_dm_old_rule" ]; then
    sed -e "s|lxc-serial-rebind-${_dm_old}\.service|lxc-serial-rebind-${_dm_new}.service|g" \
        "$_dm_old_rule" > "$_dm_new_rule" || {
      echo "  WARN: failed to write ${_dm_new_rule}" >&2
      rm -f "$_dm_new_rule"
    }
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >&2 2>/dev/null || true
    systemctl enable "lxc-serial-rebind-${_dm_new}.service" >&2 2>/dev/null || true
  fi
  if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules >&2 2>/dev/null || true
    udevadm trigger >&2 2>/dev/null || true
  fi
  # The old VMID's watcher is intentionally left in place: the source container
  # may still be running until the replace/cleanup phase, and a roll-back must
  # find it intact. Its ExecStart no-ops once the source container is gone
  # (`pct pid` returns empty -> exit 0), so a stale unit is harmless.
}

# Migrate the full serial device mapping (lxc lines + replug watcher) from a
# source container to a freshly created/cloned target container. Safe to call
# unconditionally: it is a no-op when no device mapping exists on the source.
# Args: old_vmid new_vmid
migrate_device_mapping() {
  _dm_o="$1"
  _dm_n="$2"
  [ -n "$_dm_o" ] && [ "$_dm_o" != "NOT_DEFINED" ] || return 0
  [ -n "$_dm_n" ] && [ "$_dm_n" != "NOT_DEFINED" ] || return 0
  [ "$_dm_o" = "$_dm_n" ] && return 0
  copy_device_lxc_lines "/etc/pve/lxc/${_dm_o}.conf" "/etc/pve/lxc/${_dm_n}.conf"
  restamp_serial_replug_watcher "$_dm_o" "$_dm_n"
}
