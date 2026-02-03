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

def not_defined(val: str) -> bool:
    return val == "NOT_DEFINED" or val == ""

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

    # Strip OCI prefix for display
    oci_image_visible = oci_image_raw
    for prefix in ["docker://", "oci://"]:
        if oci_image_visible.startswith(prefix):
            oci_image_visible = oci_image_visible[len(prefix):]
            break

    # Log file path
    log_file = f"/var/log/lxc/{hostname}-{VMID}.log" if hostname else ""

    # Build notes content
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

    # Visible content (Markdown)
    lines.append("# LXC Manager")
    lines.append("")

    # Show application icon if available (using Data URL)
    if icon_base64 and icon_mime_type:
        icon_alt = app_name if app_name else app_id
        lines.append(f"![{icon_alt}](data:{icon_mime_type};base64,{icon_base64})")
        lines.append("")

    lines.append("Managed by **lxc-manager**.")

    # Application info
    if app_id or app_name:
        lines.append("")
        if app_id and app_name:
            lines.append(f"## {app_name}")
            lines.append("")
            lines.append(f"Application ID: {app_id}")
        elif app_name:
            lines.append(f"## {app_name}")
        else:
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
    if hostname:
        lines.append("")
        lines.append(f"Log file: {log_file}")

    # Links section
    if deployer_url and ve_context:
        lines.append("")
        lines.append("## Links")
        lines.append(f"- [Console Logs]({deployer_url}/logs/{VMID}/{ve_context})")

    notes_content = "\n".join(lines)

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
