#!/bin/sh
# Volume Consistency Check — SCOPED TO THE CURRENT SCENARIO'S VMID(S).
#
# Validates that volumes "owned" by this install are in a consistent state:
#   1. Every volume currently attached to vm_id via `pct config <vm_id>` must
#      actually exist on its storage backend (pvesm path resolves + file/
#      dataset present).
#   2. Every volume whose name encodes the vm_id prefix (subvol-<vm_id>-…)
#      must be attached to that VM's pct config — i.e. no `orphan_unmounted`
#      leftovers from this install's own work.
#   3. If previous_vm_id is set (replace_ct flow), the same applies to the
#      previous VMID — its container is gone by post_start time, so ANY
#      subvol or snapshot still bearing that vmid is this scenario's mess to
#      clean up.
#
# Explicit non-goal: this check does NOT scan the whole host for orphans
# belonging to other VMs. Under --parallel that scan racy-collided with peer
# scenarios mid-`pct destroy`/`replace_ct`, producing transient
# `orphan_vmid_gone` false positives. "Vor der eigenen Tür kehren" — system-
# wide hygiene belongs in a separate maintenance template/cron, not in every
# per-install post_start.
#
# Required libraries (prepended by template engine):
#   - pve-common.sh
#   - vol-common.sh
#
# Template variables:
#   vm_id           — current container VMID (required)
#   previous_vm_id  — previous VMID for replace_ct flow (optional / empty)
#
# Output JSON (stdout) — conforms to schemas/outputs.schema.json.

GRACE_SECONDS=60

VM_ID="{{ vm_id }}"
PREV_VM_ID="{{ previous_vm_id }}"

# previous_vm_id is the canonical empty form when no replace_ct is in flight
# (template engine substitutes NOT_DEFINED for unset internal parameters —
# see replace-ct.sh for the same idiom).
[ "$PREV_VM_ID" = "NOT_DEFINED" ] && PREV_VM_ID=""

results="["
all_passed=true

add_result() {
    check="$1"
    passed="$2"
    detail="$3"
    [ "$results" != "[" ] && results="${results},"
    if [ -n "$detail" ]; then
        escaped=$(printf '%s' "$detail" | sed 's/"/\\"/g' | tr '\n' ' ')
        results="${results}{\"name\":\"${check}\",\"value\":${passed},\"description\":\"${escaped}\"}"
    else
        results="${results}{\"name\":\"${check}\",\"value\":${passed}}"
    fi
}

# Get the host-side mtime (epoch seconds) for a volume. 0 if not resolvable.
volume_mtime() {
    _vc_volid="$1"
    _vc_path=$(pvesm path "$_vc_volid" 2>/dev/null || true)
    [ -z "$_vc_path" ] && { echo 0; return; }
    [ -e "$_vc_path" ] || { echo 0; return; }
    stat -c %Y "$_vc_path" 2>/dev/null || echo 0
}

now=$(date +%s)

# (1) Every volume attached to vm_id must exist on storage.
check_attached_volumes_exist() {
    _av_vmid="$1"
    _av_label="$2"

    if [ -z "$_av_vmid" ]; then
        return 0
    fi
    # Container may already be gone (replace_ct OLD vmid): that's fine — its
    # subvols are then enumerated by (2) via `pvesm list`, not here.
    if ! pct config "$_av_vmid" >/dev/null 2>&1; then
        return 0
    fi

    _av_volids=$(pct config "$_av_vmid" 2>/dev/null \
        | awk '/^(rootfs|mp[0-9]+):/ {
            line=$0; sub(/^[^:]+:[[:space:]]+/, "", line);
            n=split(line, a, ",");
            print a[1];
          }')

    _av_passed=true
    for _av_volid in $_av_volids; do
        _av_path=$(pvesm path "$_av_volid" 2>/dev/null || true)
        if [ -z "$_av_path" ] || [ ! -e "$_av_path" ]; then
            _av_passed=false
            all_passed=false
            echo "  [FAIL] ${_av_volid}: attached to vmid ${_av_vmid} (${_av_label}) but storage path missing" >&2
            add_result "attached_volume_missing_${_av_volid}" "false" \
                "attached to ${_av_vmid} but storage path not found"
        fi
    done
    $_av_passed
}

# (2) Every subvol whose name encodes <vmid> as the vmid prefix must be
# attached to that vmid's pct config (or, if the vmid is gone, count as an
# orphan from this scenario's previous_vm_id).
check_own_vmid_subvols() {
    _ov_vmid="$1"
    _ov_label="$2"
    _ov_require_attached="$3"  # "true" if vmid is expected to still exist

    if [ -z "$_ov_vmid" ]; then
        return 0
    fi

    _ov_storages=$(vol_list_active_storages)
    [ -z "$_ov_storages" ] && return 0

    _ov_passed=true
    for _ov_storage in $_ov_storages; do
        _ov_volids=$(pvesm list "$_ov_storage" --content rootdir 2>/dev/null \
            | awk 'NR>1 {print $1}')
        for _ov_volid in $_ov_volids; do
            _ov_volname="${_ov_volid#*:}"
            _ov_volvmid=$(vol_extract_vmid "$_ov_volname")
            [ "$_ov_volvmid" = "$_ov_vmid" ] || continue

            _ov_class=$(vol_classify "$_ov_storage" "$_ov_volid")
            case "$_ov_class" in
                active)
                    # OK — referenced by its own container.
                    ;;
                orphan_unmounted)
                    # Subvol named for our vmid but not in its pct config.
                    _ov_mtime=$(volume_mtime "$_ov_volid")
                    _ov_age=$(( now - _ov_mtime ))
                    if [ "$_ov_mtime" -gt 0 ] && [ "$_ov_age" -lt "$GRACE_SECONDS" ]; then
                        echo "  [skip] ${_ov_volid}: orphan_unmounted (${_ov_label}) but mtime ${_ov_age}s ago — within ${GRACE_SECONDS}s grace" >&2
                        continue
                    fi
                    _ov_passed=false
                    all_passed=false
                    _ov_pool=$(vol_get_zfs_pool "$_ov_storage" 2>/dev/null)
                    echo "  [FAIL] ${_ov_volid}: orphan_unmounted (vmid ${_ov_vmid} = ${_ov_label})" >&2
                    if [ -n "$_ov_pool" ]; then
                        echo "    Suggested cleanup: zfs destroy -r ${_ov_pool}/${_ov_volname}" >&2
                    else
                        echo "    Suggested cleanup: pvesm free ${_ov_volid}" >&2
                    fi
                    add_result "orphan_unmounted_${_ov_volid}" "false" \
                        "orphan_unmounted: ${_ov_volid} (vmid ${_ov_label})"
                    ;;
                orphan_vmid_gone)
                    if [ "$_ov_require_attached" = "true" ]; then
                        # We expected this vmid to be alive (own install).
                        # Apply a brief grace + retry: a transient pct race
                        # (concurrent pct destroy/create elsewhere can stall
                        # /etc/pve briefly) is not our concern.
                        _ov_mtime=$(volume_mtime "$_ov_volid")
                        _ov_age=$(( now - _ov_mtime ))
                        if [ "$_ov_mtime" -gt 0 ] && [ "$_ov_age" -lt "$GRACE_SECONDS" ]; then
                            echo "  [skip] ${_ov_volid}: vmid ${_ov_vmid} transiently absent, subvol mtime ${_ov_age}s — within grace" >&2
                            continue
                        fi
                        _ov_passed=false
                        all_passed=false
                        echo "  [FAIL] ${_ov_volid}: own vmid ${_ov_vmid} not in pct list" >&2
                        add_result "own_vmid_gone_${_ov_volid}" "false" \
                            "vmid ${_ov_vmid} not in pct list"
                    else
                        # previous_vm_id case: vmid SHOULD be gone, leftover
                        # subvol is this scenario's mess.
                        _ov_passed=false
                        all_passed=false
                        _ov_pool=$(vol_get_zfs_pool "$_ov_storage" 2>/dev/null)
                        echo "  [FAIL] ${_ov_volid}: leftover from previous_vm_id ${_ov_vmid} (${_ov_label})" >&2
                        if [ -n "$_ov_pool" ]; then
                            echo "    Suggested cleanup: zfs destroy -r ${_ov_pool}/${_ov_volname}" >&2
                        else
                            echo "    Suggested cleanup: pvesm free ${_ov_volid}" >&2
                        fi
                        add_result "previous_vmid_leftover_${_ov_volid}" "false" \
                            "leftover from previous_vm_id ${_ov_vmid}"
                    fi
                    ;;
                *)
                    # persistent_clean / orphan_qemu_unknown / unknown:
                    # not our doorstep.
                    ;;
            esac
        done
    done
    $_ov_passed
}

# (3) Snapshots whose dataset is for vm_id but no longer referenced —
# only the own/previous vmid's snapshots are considered.
check_own_vmid_snapshots() {
    _os_vmid="$1"
    _os_label="$2"
    [ -z "$_os_vmid" ] && return 0

    _os_passed=true
    for _os_storage in $(vol_list_active_storages); do
        [ "$(vol_get_storage_type "$_os_storage")" = "zfspool" ] || continue
        _os_pool=$(vol_get_zfs_pool "$_os_storage")
        [ -z "$_os_pool" ] && continue

        zfs list -H -o name -t snapshot 2>/dev/null \
            | grep -E "^${_os_pool}/subvol-${_os_vmid}-" \
            | while IFS= read -r _os_snap; do
                _os_parent="${_os_snap%@*}"
                _os_parent_name="${_os_parent##*/}"
                # Snapshot belongs to our vmid by name. Is the parent dataset
                # still active for this vmid? If parent is missing entirely
                # → orphan. If parent exists but vmid is gone → orphan.
                if ! zfs list -H -o name "$_os_parent" >/dev/null 2>&1; then
                    _os_passed=false
                    all_passed=false
                    echo "  [FAIL] ${_os_snap}: parent dataset missing (vmid ${_os_label})" >&2
                    echo "    Suggested cleanup: zfs destroy ${_os_snap}" >&2
                    add_result "orphan_snapshot_${_os_snap}" "false" \
                        "parent dataset missing"
                    continue
                fi
                if ! vol_get_active_lxc_ids | grep -qx "$_os_vmid"; then
                    _os_passed=false
                    all_passed=false
                    echo "  [FAIL] ${_os_snap}: vmid ${_os_vmid} gone (${_os_label})" >&2
                    echo "    Suggested cleanup: zfs destroy ${_os_snap}" >&2
                    add_result "orphan_snapshot_${_os_snap}" "false" \
                        "vmid ${_os_vmid} gone"
                fi
              done
    done
    $_os_passed
}

# --- Drive the checks ---

if [ -z "$VM_ID" ]; then
    add_result "volume_consistency" "true" "no vm_id provided"
    echo "CHECK: volume_consistency PASSED (no vm_id)" >&2
else
    echo "Scoped volume-consistency: vm_id=${VM_ID} previous_vm_id=${PREV_VM_ID:-<none>}" >&2

    check_attached_volumes_exist "$VM_ID" "own"
    check_own_vmid_subvols       "$VM_ID" "own" "true"
    check_own_vmid_snapshots     "$VM_ID" "own"

    if [ -n "$PREV_VM_ID" ]; then
        check_attached_volumes_exist "$PREV_VM_ID" "previous"
        check_own_vmid_subvols       "$PREV_VM_ID" "previous" "false"
        check_own_vmid_snapshots     "$PREV_VM_ID" "previous"
    fi

    if $all_passed; then
        echo "CHECK: volume_consistency PASSED (vm_id=${VM_ID})" >&2
        add_result "volume_consistency" "true" "vm_id=${VM_ID}"
    else
        echo "CHECK: volume_consistency FAILED (vm_id=${VM_ID})" >&2
    fi
fi

results="${results}]"

# Wrap in the standard output envelope expected by templates with outputs:["volume_consistency"].
printf '[{"id":"volume_consistency","value":%s}]\n' "$results"

if $all_passed; then
    exit 0
else
    exit 1
fi
