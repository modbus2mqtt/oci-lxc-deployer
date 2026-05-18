# Node-RED

Flow-based programming tool for wiring together hardware devices, APIs, and online services.

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `node-red` | Container hostname |
| `volumes` | `data=/data`, `certs` | Flow data and certificates |

## Configuration

### settings.js

Upload a custom `settings.js` file during installation to configure Node-RED behavior (authentication, editor settings, logging, etc.). The file is placed in the `data` volume at `/data/settings.js`.

The upload only runs during installation. To update `settings.js` after deployment, edit the file directly in the volume on the PVE host and restart the container.

### Serial/USB Devices

Node-RED supports serial device passthrough for hardware integration (e.g. Zigbee sticks, serial sensors). Use the `serial_tty` parameter to map a host device into the container.

## OIDC Authentication

Enable the `addon-oidc` addon to protect Node-RED with Zitadel authentication. The callback path is `/auth/strategy/callback`.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 1880 | HTTP | Node-RED editor and dashboard |

## Addons

| Addon | Description |
|-------|-------------|
| `addon-oidc` | OpenID Connect authentication via Zitadel |
| `addon-mtls` | mTLS client certs — **manual** flow configuration required (see below) |

## addon-mtls

> **Warning — manual configuration required.** The `addon-mtls` addon only
> *provisions* client certificates; Node-RED is **not** auto-configured. You
> must wire the certificates into your flow yourself.

The addon writes a CA-signed client certificate (CN = container hostname,
default `node-red`) into the `mtls/` subdir of the `certs` volume, which
Node-RED mounts at `/certs`:

```
/certs/mtls/node-red/privkey.pem    # client private key
/certs/mtls/node-red/cert.pem       # client certificate
/certs/mtls/node-red/chain.pem      # root CA public certificate
```

### SSL vs mTLS (read first)

Supplying only the **CA** (`chain.pem`) verifies the *server* → one-way SSL.
**Mutual** TLS additionally requires the client to present its own
**`cert.pem` + `privkey.pem`**, *and* the server to enforce client certs
(e.g. eclipse-mosquitto with `require_certificate true`). The example below
sends the client key+cert — that is what makes it mTLS, not plain SSL.

### Example — MQTT to eclipse-mosquitto over mTLS

Import this flow (Menu → Import). It is a core `tls-config` node (points at
the three files above) referenced by an `mqtt-broker` config node, plus an
`mqtt out` node that publishes to the mTLS-protected broker on port 8883:

```json
[
  {
    "id": "mtls-tls", "type": "tls-config", "name": "mtls-client",
    "cert": "/certs/mtls/node-red/cert.pem",
    "key": "/certs/mtls/node-red/privkey.pem",
    "ca": "/certs/mtls/node-red/chain.pem",
    "verifyservercert": true
  },
  {
    "id": "mtls-broker", "type": "mqtt-broker", "name": "mosquitto-mtls",
    "broker": "eclipse-mosquitto", "port": "8883",
    "usetls": true, "tls": "mtls-tls", "protocolVersion": "4"
  },
  {
    "id": "mtls-pub", "type": "mqtt out", "name": "publish",
    "topic": "node-red/demo", "qos": "0", "broker": "mtls-broker",
    "x": 300, "y": 120, "z": "demo-flow", "wires": []
  }
]
```

The broker side (eclipse-mosquitto with `require_certificate true` /
`use_identity_as_username true`) maps the certificate CN to the
authenticated MQTT username (`node-red`).

Database access via PostgREST is documented separately and is out of scope
for this addon's Node-RED integration.

## Upgrade

Pulls new Node-RED image. Flows and installed nodes in the data volume are preserved.
