#!/bin/sh
# Fix LXC rootfs ownership after `pct create` + idmap setup.
#
# Context: `pct create` extracts the OCI image's raw uids/gids straight into
# the host filesystem (no idmap shift). When the resulting unprivileged LXC
# uses an idmap that does NOT 1:1-pass-through the app's uid (e.g. the
# Dockerfile adduser-uid lands at a different host-uid than the active
# idmap entry), files created in-image by `chown <uid>:<gid>` end up
# owned by the wrong host-uid. Inside the container the process running as
# uid then sees those files as "nobody" and write attempts fail with
# Permission denied (e.g. gunicorn's `~/.gunicorn` heartbeat).
#
# This script walks the listed paths inside the rootfs and re-chowns any
# file/dir already owned by the container's `uid` (or `gid`) to the
# host-side `mapped_uid:mapped_gid` produced by the preceding idmap setup.
# Files owned by other users (root, system service uids, ...) are left
# alone — system paths (/etc, /var/log) stay correctly root-owned.
#
# Inputs (template variables):
#   - vm_id:                LXC container ID
#   - uid:                  Container-side application UID (e.g. "1000")
#   - gid:                  Container-side application GID (e.g. "1000")
#   - mapped_uid:           Host-side UID after idmap (from setup-uid-mapping)
#   - mapped_gid:           Host-side GID after idmap (from setup-gid-mapping)
#   - permission_fix_paths: Space-separated list of paths inside the rootfs
#                           to walk (default "/")
#
# Skips silently if:
#   - uid is 0 / unset / "NOT_DEFINED" — root maps via the shifted range,
#     no per-file fix is meaningful
#   - permission_fix_paths is empty / "NOT_DEFINED"
#   - mapped_uid is empty (idmap setup produced no mapping)
#
# Output: empty JSON array (no outputs).

set -e

VMID="{{ vm_id }}"
CONTAINER_UID="{{ uid }}"
CONTAINER_GID="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"
FIX_PATHS="{{ permission_fix_paths }}"

skip() {
    echo "fix-permissions: $1, skipping" >&2
    printf '[]\n'
    exit 0
}

[ -z "$CONTAINER_UID" ] || [ "$CONTAINER_UID" = "0" ] || [ "$CONTAINER_UID" = "NOT_DEFINED" ] \
    && skip "uid is root/unset"
[ -z "$FIX_PATHS" ] || [ "$FIX_PATHS" = "NOT_DEFINED" ] \
    && skip "no permission_fix_paths set"
[ -z "$MAPPED_UID" ] || [ "$MAPPED_UID" = "NOT_DEFINED" ] \
    && skip "mapped_uid empty — idmap step produced no mapping"

# mapped_gid falls back to mapped_uid when the application sets only uid
# (setup-lxc-gid-mapping uses uid as fallback in that case).
TARGET_GID="${MAPPED_GID:-$MAPPED_UID}"
[ "$TARGET_GID" = "NOT_DEFINED" ] && TARGET_GID="$MAPPED_UID"

# Resolve the host-side rootfs path for this VMID.
# pct config line looks like:  `rootfs: local-zfs-3:subvol-238-disk-0,size=512M`
# We need everything after the first `: ` and before the first `,`
# (i.e. the storage:volume reference). Splitting on `:` alone breaks
# because the volume reference itself contains a `:`.
ROOTFS_VOLID=$(pct config "$VMID" 2>/dev/null \
    | awk '/^rootfs:/ {sub(/^rootfs:[[:space:]]+/, ""); split($0, a, ","); print a[1]; exit}')
if [ -z "$ROOTFS_VOLID" ]; then
    echo "fix-permissions: ERROR — cannot find rootfs in pct config $VMID" >&2
    exit 1
fi

ROOTFS_PATH=$(pvesm path "$ROOTFS_VOLID" 2>/dev/null || true)
if [ -z "$ROOTFS_PATH" ] || [ ! -d "$ROOTFS_PATH" ]; then
    echo "fix-permissions: ERROR — pvesm path '$ROOTFS_VOLID' returned no directory ('$ROOTFS_PATH')" >&2
    exit 1
fi

# pct create extracts an unprivileged container's OCI image with the subuid
# shift applied: image-uid 0 → host-uid STANDARD_START (100000), image-uid N
# → host-uid STANDARD_START + N. So a Dockerfile that did `chown -R 1000:1000
# /home/app` lands on the host as /home/app owned by 101000:101000.
# The idmap then either passes through that container-uid (passthrough: host
# 1000 ↔ container 1000) or keeps it shifted (host 101000 ↔ container 1001).
# In the passthrough case, the in-rootfs file ownership disagrees with the
# active mapping → the running container-process at uid 1000 sees the file
# as owned by uid 1001 and write attempts fail.
# Fix: also chown the files that landed at the shifted uid back to the host
# side mapped_uid.
STANDARD_START=100000
EXTRACT_UID=$((STANDARD_START + CONTAINER_UID))
EXTRACT_GID=""
if [ -n "$CONTAINER_GID" ] && [ "$CONTAINER_GID" != "NOT_DEFINED" ] && [ "$CONTAINER_GID" != "0" ]; then
    EXTRACT_GID=$((STANDARD_START + CONTAINER_GID))
fi

echo "fix-permissions: vm_id=$VMID rootfs=$ROOTFS_PATH container_uid=$CONTAINER_UID(extract=$EXTRACT_UID) gid=$CONTAINER_GID(extract=$EXTRACT_GID) -> mapped_uid=$MAPPED_UID:$TARGET_GID paths='$FIX_PATHS'" >&2

# IFS=space so we split FIX_PATHS on spaces (template variable comes as one
# string).
old_ifs="$IFS"
IFS=' '
# shellcheck disable=SC2086
set -- $FIX_PATHS
IFS="$old_ifs"

for path in "$@"; do
    rel="${path#/}"
    full="$ROOTFS_PATH${rel:+/$rel}"
    if [ ! -e "$full" ]; then
        echo "fix-permissions: skipping non-existent $full" >&2
        continue
    fi
    # Pass 1: files currently at the raw container-side uid (unshifted extract
    # or already-fixed-but-need-remap state).
    n_uid=$(find "$full" -uid "$CONTAINER_UID" -exec chown "$MAPPED_UID:$TARGET_GID" {} + -print 2>/dev/null | wc -l | tr -d ' ')
    # Pass 2: files at the subuid-shifted uid (pct create with subuid shift —
    # the common case for unprivileged containers carrying a Dockerfile chown).
    n_uid_ext=$(find "$full" -uid "$EXTRACT_UID" -exec chown "$MAPPED_UID:$TARGET_GID" {} + -print 2>/dev/null | wc -l | tr -d ' ')
    echo "fix-permissions: chowned $n_uid (uid=$CONTAINER_UID) + $n_uid_ext (uid=$EXTRACT_UID) under $full -> $MAPPED_UID:$TARGET_GID" >&2

    # Pass 3+4: gid-only matches (file group-owned by app gid but uid is e.g.
    # root/system). Only meaningful when gid differs from uid.
    if [ -n "$CONTAINER_GID" ] && [ "$CONTAINER_GID" != "$CONTAINER_UID" ] \
       && [ "$CONTAINER_GID" != "NOT_DEFINED" ] && [ "$CONTAINER_GID" != "0" ]; then
        n_gid=$(find "$full" -gid "$CONTAINER_GID" ! -uid "$CONTAINER_UID" ! -uid "$EXTRACT_UID" -exec chgrp "$TARGET_GID" {} + -print 2>/dev/null | wc -l | tr -d ' ')
        n_gid_ext=$(find "$full" -gid "$EXTRACT_GID" ! -uid "$CONTAINER_UID" ! -uid "$EXTRACT_UID" -exec chgrp "$TARGET_GID" {} + -print 2>/dev/null | wc -l | tr -d ' ')
        echo "fix-permissions: chgrped $n_gid (gid=$CONTAINER_GID) + $n_gid_ext (gid=$EXTRACT_GID) under $full -> :$TARGET_GID" >&2
    fi
done

printf '[]\n'
