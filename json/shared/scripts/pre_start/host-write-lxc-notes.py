#!/usr/bin/env python3
# host-write-lxc-notes.py
# Writes the LXC container notes/description.
# Called at the end of conf-* scripts, before container start.
# This allows all configuration scripts to contribute their information.

import subprocess
import sys
import json

# Template variables (will be replaced by backend)
VMID = "{{ vm_id }}"
TEMPLATE_PATH = "{{ template_path }}"
OCI_IMAGE_RAW = "{{ oci_image }}"
APP_ID_RAW = "{{ application_id }}"
APP_NAME_RAW = "{{ application_name }}"
VERSION_RAW = "{{ oci_image_tag }}"
DEPLOYER_URL_RAW = "{{ deployer_base_url }}"
VE_CONTEXT_RAW = "{{ ve_context_key }}"
HOSTNAME_RAW = "{{ hostname }}"
ICON_BASE64 = "{{ icon_base64 }}"
ICON_MIME_TYPE = "{{ icon_mime_type }}"
USERNAME_RAW = "{{ username }}"
UID_RAW = "{{ uid }}"
GID_RAW = "{{ gid }}"

PVE_DESCRIPTION_LIMIT = 8192

def not_defined(val: str) -> bool:
    return val == "NOT_DEFINED" or val == ""

def build_notes(*, include_icon: bool, oci_image_visible: str, app_id: str,
                app_name: str, version: str, deployer_url: str, ve_context: str,
                hostname: str, icon_base64: str, icon_mime_type: str,
                username: str, uid: str, gid: str, template_path: str) -> str:
    lines = []

    # Hidden markers for machine parsing
    lines.append("<!-- oci-lxc-deployer:managed -->")
    if oci_image_visible:
        lines.append(f"<!-- oci-lxc-deployer:oci-image {oci_image_visible} -->")
    if app_id:
        lines.append(f"<!-- oci-lxc-deployer:application-id {app_id} -->")
    if app_name:
        lines.append(f"<!-- oci-lxc-deployer:application-name {app_name} -->")
    if version:
        lines.append(f"<!-- oci-lxc-deployer:version {version} -->")
    if deployer_url and ve_context:
        lines.append(f"<!-- oci-lxc-deployer:log-url {deployer_url}/logs/{VMID}/{ve_context} -->")
    if icon_base64 and icon_mime_type:
        lines.append(f"<!-- oci-lxc-deployer:icon-url data:{icon_mime_type};base64,... -->")
    if username:
        lines.append(f"<!-- oci-lxc-deployer:username {username} -->")
    if uid:
        lines.append(f"<!-- oci-lxc-deployer:uid {uid} -->")
    if gid:
        lines.append(f"<!-- oci-lxc-deployer:gid {gid} -->")

    # Visible content (Markdown)
    header_name = app_name if app_name else app_id if app_id else "Container"
    lines.append(f"# {header_name}")
    lines.append("")

    # Show application icon if available (using Data URL)
    if include_icon and icon_base64 and icon_mime_type:
        icon_alt = app_name if app_name else app_id
        lines.append(f'<img src="data:{icon_mime_type};base64,{icon_base64}" width="16" height="16" alt="{icon_alt}"/>')
        lines.append("")

    # Link to oci-lxc-deployer if URL available
    if deployer_url:
        lines.append(f"Managed by [oci-lxc-deployer]({deployer_url}/).")
    else:
        lines.append("Managed by **oci-lxc-deployer**.")

    # Application ID (only if different from name shown in header)
    if app_id and app_id != app_name:
        lines.append("")
        lines.append(f"Application ID: {app_id}")

    # Version
    if version:
        lines.append("")
        lines.append(f"Version: {version}")

    # OCI image or LXC template
    if oci_image_visible:
        lines.append("")
        lines.append(f"OCI image: {oci_image_visible}")
    elif template_path:
        lines.append("")
        lines.append(f"LXC template: {template_path}")

    # Log file location
    log_file = f"/var/log/lxc/{hostname}-{VMID}.log" if hostname else ""
    if hostname:
        lines.append("")
        lines.append(f"Log file: {log_file}")

    # Links section
    if deployer_url and ve_context:
        lines.append("")
        lines.append("## Links")
        lines.append(f"- [Console Logs]({deployer_url}/logs/{VMID}/{ve_context})")

    return "\n".join(lines)

def main():
    config_file = f"/etc/pve/lxc/{VMID}.conf"

    # Normalize values
    template_path = "" if not_defined(TEMPLATE_PATH) else TEMPLATE_PATH
    oci_image_raw = "" if not_defined(OCI_IMAGE_RAW) else OCI_IMAGE_RAW
    app_id = "" if not_defined(APP_ID_RAW) else APP_ID_RAW
    app_name = "" if not_defined(APP_NAME_RAW) else APP_NAME_RAW
    version = "" if not_defined(VERSION_RAW) else VERSION_RAW
    deployer_url = "" if not_defined(DEPLOYER_URL_RAW) else DEPLOYER_URL_RAW
    ve_context = "" if not_defined(VE_CONTEXT_RAW) else VE_CONTEXT_RAW
    hostname = "" if not_defined(HOSTNAME_RAW) else HOSTNAME_RAW
    icon_base64 = "" if not_defined(ICON_BASE64) else ICON_BASE64
    icon_mime_type = "" if not_defined(ICON_MIME_TYPE) else ICON_MIME_TYPE
    username = "" if not_defined(USERNAME_RAW) else USERNAME_RAW
    uid = "" if not_defined(UID_RAW) else UID_RAW
    gid = "" if not_defined(GID_RAW) else GID_RAW

    # Strip OCI prefix for display
    oci_image_visible = oci_image_raw
    for prefix in ["docker://", "oci://"]:
        if oci_image_visible.startswith(prefix):
            oci_image_visible = oci_image_visible[len(prefix):]
            break

    # Build notes content
    notes_args = dict(
        oci_image_visible=oci_image_visible, app_id=app_id, app_name=app_name,
        version=version, deployer_url=deployer_url, ve_context=ve_context,
        hostname=hostname, icon_base64=icon_base64, icon_mime_type=icon_mime_type,
        username=username, uid=uid, gid=gid, template_path=template_path,
    )
    notes_content = build_notes(include_icon=True, **notes_args)

    # Proxmox limits description to 8192 characters; omit inline icon if exceeded
    if len(notes_content) > PVE_DESCRIPTION_LIMIT:
        print(f"Notes exceed {PVE_DESCRIPTION_LIMIT} chars ({len(notes_content)}), omitting inline icon", file=sys.stderr)
        notes_content = build_notes(include_icon=False, **notes_args)

    # Write notes using pct set
    try:
        result = subprocess.run(
            ["pct", "set", VMID, "--description", notes_content],
            capture_output=True,
            text=True
        )
        if result.returncode != 0:
            print(f"Warning: pct set failed: {result.stderr}", file=sys.stderr)
        else:
            print(f"Notes written for container {VMID}", file=sys.stderr)
    except Exception as e:
        print(f"Warning: Failed to write notes: {e}", file=sys.stderr)

    # Output JSON result
    print(json.dumps({"id": "notes_written", "value": "true"}))

if __name__ == "__main__":
    main()
