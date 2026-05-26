# wolproxy

Minimal HTTP shim that turns Wake-on-LAN and reachability checks into a
stable JSON API. Two endpoints, idempotent, network-only (no SSH, no
credentials of its own).

## Endpoints

| Method | Path                                | Effect |
|--------|-------------------------------------|--------|
| POST   | `/wake?mac=...&broadcast=...&port=` | Sends Magic Packet via UDP broadcast |
| GET    | `/status?ip=...`                    | `ping -c1 -W2 <ip>` → `awake` or `asleep` |
| GET    | `/health`                           | `{"status": "ok"}` |

Parameters:

- `mac`: target MAC, any of `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff`, `aabbccddeeff`.
- `broadcast` (default `255.255.255.255`): UDP broadcast address. In a LAN that's the subnet broadcast (e.g. `192.168.1.255`).
- `port` (default `9`): UDP destination port.
- `ip`: target LAN IP for the ping probe.

## Shutdown is NOT a wolproxy concern

Power-down is intentionally outside wolproxy. The natural place is the
PVE REST API — the same scoped token a Workflow uses for snapshot
operations can also call `POST /nodes/<node>/status` with `command=shutdown`,
provided it has `Sys.PowerMgmt` on `/nodes/<node>`. Keeping wolproxy
credential-free makes it easier to deploy and audit.

## Auth

The image itself has no auth. Production deployments put addon-oauth2-proxy
in front (Bearer JWT against Zitadel), same pattern as gptwol. Internally
addon-oauth2-proxy proxies to wolproxy on the loopback port; the wolproxy
port itself is firewalled away from the outside world.

## Network requirements

The container must reach the target LAN as broadcast — so its LXC config
needs to attach to the LAN bridge (typically `vmbr0`), not a NAT bridge.
`SO_BROADCAST` works in unprivileged LXCs; no capability hacks needed.

## Addons

| Addon | Purpose |
|-------|---------|
| `addon-oauth2-proxy` | Validates Bearer JWTs before requests reach wolproxy |
| `addon-ssl` | Internal-CA TLS for the upstream port |
| `addon-acme` | Public-trust cert via Let's Encrypt (production only) |
