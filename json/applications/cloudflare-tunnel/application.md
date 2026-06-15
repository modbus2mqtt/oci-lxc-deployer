# Cloudflare Tunnel

Runs [`cloudflared`](https://github.com/cloudflare/cloudflared) as a **remotely-managed** Cloudflare Tunnel connector, deployed as a **Docker Compose** service inside an LXC (`extends: docker-compose`).

The connector makes an **outbound-only** connection to Cloudflare's edge. There are no inbound ports and no local TLS. All ingress / public-hostname routing — e.g. `git.ohnewarum.de` → internal Gitea, `auth.ohnewarum.de` → internal Zitadel, `ohnewarum.de` → origin — is configured in the **Cloudflare Zero Trust dashboard**, not in this application.

## Why docker-compose (not oci-image)

The official `cloudflare/cloudflared` image is **distroless** (no shell, runs as PID 1). On the `oci-image` framework, cloudflared becomes the container's init and starts **before the LXC network is up**, so its first edge-discovery DNS lookup fails with `network is unreachable` and — because cloudflared does not retry edge discovery at boot — it exits immediately and the container stops. A distroless image also can't run the framework's `/bin/sh`-based `wait-for-network` shim.

The docker-compose framework solves this cleanly:

- The LXC is a full Debian-with-Docker host with normal init and network bring-up.
- cloudflared runs as a Compose service with **`restart: unless-stopped`**, so Docker simply restarts it until the network is ready and the edge is reachable — no custom wait-for-network needed.
- `network_mode: host` lets cloudflared use the LXC's routes/DNS directly (reaching both the Cloudflare edge and internal origins).

## Token

The connector token is injected as the `TUNNEL_TOKEN` environment variable in the compose file, sourced from the `TUNNEL_TOKEN` variable of the dedicated **`cloudflare-tunnel` stack** via `stack_usage` → `replacement: "compose-env"` (`compose_key: TUNNEL_TOKEN`). Rotation patches the compose env value and restarts the service.

> **⚠️ Token type.** A Cloudflare Tunnel **connector** token (base64 JSON from the Zero Trust dashboard / `cloudflared tunnel token <name>`) is **not** the same as the Cloudflare **DNS API** token (`CF_TOKEN`) used by `addon-acme`. They are kept in separate stacktypes (`cloudflare-tunnel` vs `cloudflare`) on purpose.

## Setup

1. Create a stack of type **Cloudflare Tunnel** and set `TUNNEL_TOKEN` to your connector token.
2. Install `cloudflare-tunnel` and **bind that stack**. Without a bound stack, `{{ TUNNEL_TOKEN }}` resolves to `NOT_DEFINED` and cloudflared rejects the (empty) token.

## Testing

`tests/default.json` is gated on the `CF_TUNNEL_TOKEN_TEST` env var (a real connector token); without it the runner skips the scenario.

```
CF_TUNNEL_TOKEN_TEST=<connector-token> /livetest cloudflare-tunnel/default
```
