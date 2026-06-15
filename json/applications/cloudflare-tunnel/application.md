# Cloudflare Tunnel

Runs [`cloudflared`](https://github.com/cloudflare/cloudflared) as a **remotely-managed** Cloudflare Tunnel connector inside an LXC container, built on the `oci-image` framework.

The container makes an **outbound-only** connection to Cloudflare's edge. There are no inbound ports and no local TLS. All ingress / public-hostname routing — e.g. `git.ohnewarum.de` → internal Gitea, `auth.ohnewarum.de` → internal Zitadel, `ohnewarum.de` → origin — is configured in the **Cloudflare Zero Trust dashboard**, not in this application.

## Token

The connector token is passed into the container as the `TUNNEL_TOKEN` environment variable. It is sourced from the `TUNNEL_TOKEN` variable of the dedicated **`cloudflare-tunnel` stack** via `stack_usage` with `replacement: "lxc-config-env"`. On token rotation, a stack refresh patches `lxc.environment.TUNNEL_TOKEN` directly — no container rebuild needed.

> **⚠️ Token type — own stacktype on purpose.** A Cloudflare Tunnel connector token is **not** the same as a Cloudflare DNS API token. `addon-acme` stores a *DNS API token* in the `cloudflare` stack's `CF_TOKEN` for the DNS-01 ACME challenge; `cloudflared tunnel run` needs a *connector token* (a base64-encoded JSON blob containing account tag, tunnel ID and secret, obtained from the Zero Trust dashboard or `cloudflared tunnel token <name>`). These are deliberately kept in **separate stacktypes** (`cloudflare` vs `cloudflare-tunnel`) so the two token types never get confused.

## Distroless image — framework deviation

The official `cloudflare/cloudflared` image is **distroless**: it has no `/bin/sh`, no package manager, and runs as a non-root user (`65532`). The `oci-image` framework normally runs a few steps *inside* the container via `lxc-attach -- sh`, which is impossible here. This application therefore overrides the `installation`, `upgrade`, `reconfigure` and `check` tasks with `no_extend: true` and re-lists only the host-side (`execute_on: ve`) steps, dropping the in-container ones:

| Dropped base step | Reason |
|-------------------|--------|
| `210-wait-for-container-ready` | polls readiness via `lxc-attach -- /bin/sh` (apk/dpkg) — no shell in container |
| `305-post-set-pkg-mirror` | configures apk/apt mirrors inside the container — no package manager |

The base `check` (TLS/OIDC/file probes) is replaced with `900-host-check-container` (container running) plus the app-specific `check-tunnel-connected` check, which greps the LXC console log on the host for cloudflared's `Registered tunnel connection` line.

The container is started via `lxc.init.cmd` (set from `initial_command`) running the binary directly — `/usr/local/bin/cloudflared tunnel --no-autoupdate run` — which works on distroless because it execs the binary without a shell. With `TUNNEL_TOKEN` in the environment, `cloudflared tunnel run` picks the token up automatically.

## Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `cloudflare-tunnel` | Container hostname / Proxmox VM name |
| `oci_image` | `cloudflare/cloudflared:{{oci_image_tag}}` | Connector image |
| `TUNNEL_TOKEN` | (from `cloudflare-tunnel` stack) | Tunnel connector token → `TUNNEL_TOKEN` env |

## Testing

`tests/default.json` is gated on the `CF_TUNNEL_TOKEN_TEST` env var (a real connector token). Without it the livetest runner skips the scenario; with it set, the full pipeline runs and the tunnel-connected check asserts the connector reached the edge:

```
CF_TUNNEL_TOKEN_TEST=<connector-token> /livetest cloudflare-tunnel/default
```
