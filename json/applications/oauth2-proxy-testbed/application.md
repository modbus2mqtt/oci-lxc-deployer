# OAuth2 Proxy Testbed

Minimal application used to exercise [addon-oauth2-proxy](../../addons/addon-oauth2-proxy.md) in isolation.

Wraps [`traefik/whoami`](https://github.com/traefik/whoami) — a tiny HTTP echo server (~5 MB image) that returns the request headers and body. By itself the testbed has no authentication; addon-oauth2-proxy puts oauth2-proxy in front of it and locks the upstream port via iptables.

## Purpose

- Verify addon-oauth2-proxy installs cleanly on a fresh container
- Verify oauth2-proxy listens on `bearer_listen_port` (default 8443)
- Verify requests without a Bearer token receive 401
- Verify requests with an invalid Bearer token receive 401
- Verify the upstream port (80) is loopback-only after iptables rules are applied
- Verify HTTPS mode kicks in when `addon-ssl` is also enabled

## Test Scenarios

| File | Purpose |
|------|---------|
| `tests/default.json` | addon-oauth2-proxy only; HTTP listener on 8443 |

Run with: `/livetest oauth2-proxy-testbed/default`

## Not for Production

This is a test fixture. It uses a dummy upstream that echoes everything, including any Bearer token that gets forwarded — useful for debugging the proxy but not safe for real use.
