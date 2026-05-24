#!/bin/sh
# skopeo-probe.sh — evidence-gathering helpers for skopeo failures.
#
# Prepended via the template `library:` mechanism. Provides:
#   skopeo_with_probe <skopeo args...>     — runs skopeo, on non-zero exit
#                                            appends an observation block
#                                            to its captured stderr.
#   skopeo_probe_block <registry> [stderr] — produce the block on demand.
#
# Same design as the Python `run_skopeo` in oci_version_lib.py: evidence
# only, no classification, no remedy text. Labels are part of the public
# schema — keep them stable.

_skopeo_probe_step() {
    # $1 = label, remaining args are eval'd as the probe command.
    # Probe stderr is silenced — it would otherwise pollute the report
    # when a tool is missing or DNS errors.
    _spr_label="$1"; shift
    _spr_t0=$(date +%s%N 2>/dev/null || echo 0)
    _spr_out=$(eval "$@" 2>/dev/null)
    _spr_rc=$?
    _spr_t1=$(date +%s%N 2>/dev/null || echo 0)
    _spr_ms=$(( (_spr_t1 - _spr_t0) / 1000000 ))
    if [ "$_spr_rc" = "0" ]; then _spr_mark="ok  "; else _spr_mark="FAIL"; fi
    # Take only the first line of probe output — terse one-liner per step.
    _spr_first=$(printf '%s' "$_spr_out" | head -1)
    printf '  %-28s %s  %dms  %s\n' "$_spr_label" "$_spr_mark" "$_spr_ms" "$_spr_first"
}

# DNS lookup — uses getent on Linux (target environment), falls back to
# `host`/`nslookup` if missing. Returns "<host> -> <ip>" or fails.
_skopeo_probe_dns() {
    _spd_host="$1"
    if command -v getent >/dev/null 2>&1; then
        _spd_ip=$(getent hosts "$_spd_host" | awk '{print $1}' | head -1)
    elif command -v host >/dev/null 2>&1; then
        _spd_ip=$(host -t A "$_spd_host" 2>/dev/null | awk '/has address/ {print $4; exit}')
    elif command -v nslookup >/dev/null 2>&1; then
        _spd_ip=$(nslookup "$_spd_host" 2>/dev/null | awk '/^Address: / {print $2; exit}')
    fi
    if [ -n "$_spd_ip" ]; then
        printf '%s -> %s\n' "$_spd_host" "$_spd_ip"
        return 0
    fi
    echo 'unresolved'
    return 1
}

# Extract `https://host:port/v2/repo/blobs/sha256:HASH` from arbitrary text.
# Used to re-probe the exact byte stream that broke (truncated-blob case).
_skopeo_probe_extract_blob_url() {
    printf '%s' "$1" | grep -oE 'https?://[^[:space:]]+/v2/[^[:space:]]+/blobs/sha256:[0-9a-f]{8,}' | head -1
}

# Render observation block to stdout. Args:
#   $1 = registry hostname (e.g. registry-1.docker.io)
#   $2 = (optional) failing skopeo stderr — searched for blob URL
#   $3 = (optional) tested image, e.g. library/alpine:latest
skopeo_probe_block() {
    _spb_registry="$1"
    _spb_stderr="${2:-}"
    _spb_image="${3:-library/alpine:latest}"

    [ -z "$_spb_registry" ] && return 0

    printf 'Observations (auto-probed, evidence only — no diagnosis):\n'

    # 1. DNS
    _skopeo_probe_step "DNS" "_skopeo_probe_dns \"$_spb_registry\""

    # 2. Mirror /v2/ reachability (401 with WWW-Authenticate is also "up").
    _skopeo_probe_step "Mirror /v2/ GET" \
        "code=\$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 \"https://$_spb_registry/v2/\"); \
         echo \"HTTP \$code\"; [ \"\$code\" = '200' ] || [ \"\$code\" = '401' ] || [ \"\$code\" = '403' ] || [ \"\$code\" = '404' ]"

    # 3. Manifest HEAD for the requested image (split repo:tag).
    _spb_repo="${_spb_image%:*}"
    _spb_tag="${_spb_image##*:}"
    [ "$_spb_repo" = "$_spb_image" ] && _spb_tag="latest"
    _skopeo_probe_step "Manifest HEAD" \
        "out=\$(curl -skI --max-time 2 \"https://$_spb_registry/v2/$_spb_repo/manifests/$_spb_tag\"); \
         code=\$(echo \"\$out\" | head -1 | awk '{print \$2}'); \
         size=\$(echo \"\$out\" | grep -i '^content-length' | awk '{print \$2}' | tr -d '\\r'); \
         echo \"HTTP \$code content-length=\${size:-?}\"; \
         [ \"\$code\" = '200' ] || [ \"\$code\" = '401' ] || [ \"\$code\" = '403' ]"

    # 4. Control image through same network path (only if it's not the probe target).
    if [ "$_spb_image" != "library/alpine:3" ]; then
        _skopeo_probe_step "Control alpine:3" \
            "out=\$(curl -skI --max-time 2 \"https://$_spb_registry/v2/library/alpine/manifests/3\"); \
             code=\$(echo \"\$out\" | head -1 | awk '{print \$2}'); \
             echo \"HTTP \$code\"; \
             [ \"\$code\" = '200' ] || [ \"\$code\" = '401' ] || [ \"\$code\" = '403' ]"
    fi

    # 5. Failing blob — only if named in stderr.
    _spb_blob_url=$(_skopeo_probe_extract_blob_url "$_spb_stderr")
    if [ -n "$_spb_blob_url" ]; then
        _spb_label_suffix="$(printf '%s' "$_spb_blob_url" | tail -c 71)"
        _skopeo_probe_step "Blob GET (…$_spb_label_suffix)" \
            "got=\$(curl -sk --max-time 3 -r 0-4095 -o /dev/null -w '%{http_code} received=%{size_download} advertised=%{size_header}' \"$_spb_blob_url\"); \
             echo \"\$got\"; \
             echo \"\$got\" | awk '{print \$1}' | grep -qE '^(200|206)$' && \
                 [ \"\$(echo \"\$got\" | sed -n 's/.*received=\\([0-9]*\\).*/\\1/p')\" != '0' ]"
    fi
}

# Wrapper: run skopeo, capture stderr+exit; on failure print stderr + probe
# block to caller's stderr stream. Caller still sees the exit code via $? .
skopeo_with_probe() {
    # We need to peek at the image arg (last positional in skopeo's CLI).
    _swp_image=""
    for _swp_arg in "$@"; do
        case "$_swp_arg" in
            docker://*|oci-archive:*) _swp_image="$_swp_arg" ;;
        esac
    done

    _swp_out=$(skopeo "$@" 2>&1)
    _swp_rc=$?
    if [ "$_swp_rc" != "0" ]; then
        printf '%s\n' "$_swp_out" >&2
        # Parse registry host from the image ref.
        _swp_ref="${_swp_image#docker://}"
        _swp_host="${_swp_ref%%/*}"
        case "$_swp_host" in
            *.*|*:*|localhost) : ;;  # explicit registry
            *) _swp_host="registry-1.docker.io" ;;  # Docker Hub default
        esac
        skopeo_probe_block "$_swp_host" "$_swp_out" "$_swp_image" >&2
    else
        printf '%s' "$_swp_out"
    fi
    return $_swp_rc
}
