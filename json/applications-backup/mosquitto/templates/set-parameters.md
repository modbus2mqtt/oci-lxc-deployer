# Mosquitto Parameters

Set application-specific parameters for Mosquitto

**Execution Target:** ve

<!-- GENERATED_START:PARAMETERS -->
## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `hostname` | string | Yes | mosquitto | Hostname for the Mosquitto container |
| `auth_mode` | enum | Yes | password | Authentication mode: none (no authentication), password (username/password), certificate (client certificate authentication) |
| `mqtt_port` | string | No | 1883 | Port number for MQTT (default: 1883) ⚙️ Advanced |
| `mqtts_port` | string | No | 8883 | Port number for MQTT over TLS (default: 8883). Only used with certificate authentication. ⚙️ Advanced |
| `mqtt_username` | string | No | - | Username for MQTT broker login (required for password authentication mode) |
| `mqtt_password` | string | No | - | Password for MQTT broker login (required for password authentication mode) 🔒 Secure |
| `bind_address` | string | No | 0.0.0.0 | IP address to bind to. Use 0.0.0.0 to accept connections from all interfaces ⚙️ Advanced |
| `server_cert` | string | No | - | Server certificate file for TLS. If not provided, a server certificate will be generated. ⚙️ Advanced 📤 Upload |
| `server_key` | string | No | - | Server private key file for TLS. Required if server certificate is provided. ⚙️ Advanced 📤 Upload |
| `ca_cert` | string | No | - | CA certificate file for client certificate authentication (optional). If provided, client certificates will be required. ⚙️ Advanced 📤 Upload |
| `ca_key` | string | No | - | CA private key file (optional). Required if CA certificate is provided. ⚙️ Advanced 📤 Upload |

<!-- GENERATED_END:PARAMETERS -->

## Features

This template implements the following features:

- User management
- Package configuration
- Volume management
- Service configuration
- Network configuration

## Commands
