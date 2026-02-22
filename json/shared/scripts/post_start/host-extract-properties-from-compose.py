#!/usr/bin/env python3
"""Extract useful properties from Docker Compose file.

This script extracts:
- Service names (list)
- Port mappings (for firewall/documentation)
- Image tags/versions (for documentation)
- Network names (if custom)

Output: JSON to stdout with extracted properties (errors to stderr)
"""

import json
import sys
import base64
import re

try:
    import yaml
except ImportError:
    print("Error: PyYAML is required. Install it with: pip install pyyaml or apt install python3-yaml", file=sys.stderr)
    sys.exit(1)

def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)

def extract_port_mappings(services):
    """Extract port mappings from all services."""
    ports = []
    for service_name, service_config in services.items():
        if "ports" in service_config:
            for port_spec in service_config["ports"]:
                # Port spec can be: "8080:80", "8080:80/tcp", "127.0.0.1:8080:80"
                if isinstance(port_spec, str):
                    # Parse format: [host_ip:]host_port:container_port[/protocol]
                    parts = port_spec.split(":")
                    if len(parts) >= 2:
                        container_port = parts[-1].split("/")[0]
                        host_port = parts[-2] if len(parts) > 1 else parts[0]
                        ports.append(f"{service_name}:{host_port}->{container_port}")
                elif isinstance(port_spec, dict):
                    # Format: {"published": 8080, "target": 80, "protocol": "tcp"}
                    host_port = str(port_spec.get("published", ""))
                    container_port = str(port_spec.get("target", ""))
                    if host_port and container_port:
                        ports.append(f"{service_name}:{host_port}->{container_port}")
    return ports

def extract_image_tags(services):
    """Extract image tags/versions from services."""
    images = []
    for service_name, service_config in services.items():
        if "image" in service_config:
            image = service_config["image"]
            # Extract tag if present (image:tag)
            if ":" in image:
                tag = image.split(":")[-1]
                images.append(f"{service_name}:{tag}")
            else:
                images.append(f"{service_name}:latest")
    return images

def main():
    # Get parameters from template variables
    compose_file_base64 = "{{ compose_file }}"
    
    # Decode base64 compose file
    try:
        compose_file_content = base64.b64decode(compose_file_base64).decode('utf-8')
    except Exception as e:
        eprint(f"Error: Failed to decode compose file: {e}")
        sys.exit(1)
    
    # Parse YAML
    try:
        compose_data = yaml.safe_load(compose_file_content)
    except Exception as e:
        eprint(f"Error: Failed to parse YAML: {e}")
        sys.exit(1)
    
    if not compose_data:
        eprint("Error: Empty or invalid compose file")
        sys.exit(1)
    
    # Extract properties
    services = compose_data.get("services", {})
    service_names = list(services.keys()) if services else []
    
    # Extract port mappings
    port_mappings = extract_port_mappings(services) if services else []
    
    # Extract image tags
    image_tags = extract_image_tags(services) if services else []
    
    # Extract network names (custom networks, not default)
    networks = []
    if "networks" in compose_data:
        networks = list(compose_data["networks"].keys())
    
    # Build output
    output = []
    
    # Service names as comma-separated string (for display)
    if service_names:
        output.append({
            "id": "compose_services",
            "value": ", ".join(service_names)
        })
    
    # Port mappings as multiline string (for documentation/firewall)
    if port_mappings:
        output.append({
            "id": "compose_ports",
            "value": "\n".join(port_mappings)
        })
    
    # Image tags as multiline string (for documentation)
    if image_tags:
        output.append({
            "id": "compose_images",
            "value": "\n".join(image_tags)
        })
    
    # Network names as comma-separated string
    if networks:
        output.append({
            "id": "compose_networks",
            "value": ", ".join(networks)
        })
    
    eprint(f"Extracted properties: {len(service_names)} service(s), {len(port_mappings)} port(s), {len(image_tags)} image(s)")
    
    # Output JSON
    print(json.dumps(output))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        eprint(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
