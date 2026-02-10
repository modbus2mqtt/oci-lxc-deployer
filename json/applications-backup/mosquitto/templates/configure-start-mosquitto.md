# Configure Mosquitto

Configure Mosquitto MQTT broker with authentication settings

**Execution Target:** lxc

<!-- GENERATED_START:PARAMETERS -->
## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `auth_mode` | string | Yes | - | Authentication mode: none, password, or certificate |
| `mqtt_port` | string | Yes | - | Port number for MQTT |
| `mqtts_port` | string | Yes | - | Port number for MQTT over TLS |
| `mqtt_username` | string | No | - | Username for MQTT broker login |
| `mqtt_password` | string | No | - | Password for MQTT broker login |
| `bind_address` | string | Yes | - | IP address to bind to |
| `server_cert` | string | No | - | Base64-encoded server certificate content |
| `server_key` | string | No | - | Base64-encoded server private key content |
| `ca_cert` | string | No | - | Base64-encoded CA certificate content (for client certificate authentication) |

<!-- GENERATED_END:PARAMETERS -->

## Features

This template implements the following features:

- Configuration management

## Commands
