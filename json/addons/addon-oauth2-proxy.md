# OAuth2 Proxy Addon

Wraps an application with [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) running as an on-start hook inside the application's LXC. Validates incoming `Authorization: Bearer <JWT>` headers against Zitadel's JWKS endpoint, proxies validated requests to the application's internal HTTP port, and locks down the application port via iptables.

Use this addon to add **machine-to-machine Bearer-JWT authentication** to applications that:
- only support browser-flow OIDC (e.g. gptwol) and have no native API-token mechanism,
- have no authentication at all (static dashboards, simple HTTP APIs),
- need a JWT-validation tier in front of an unprotected backend.

The application itself remains unmodified — oauth2-proxy is the gatekeeper, the app sees only validated requests.

## How It Works

```
nginx (cluster-public) ──> LXC:bearer_listen_port (oauth2-proxy) ──> 127.0.0.1:http_port (app)
                                  │
                                  ├── Validates JWT signature against Zitadel JWKS (cached)
                                  └── Checks iss, aud, exp
```

1. **At install time** (pre_start), the addon registers an API application in Zitadel (`bearer_audience`) so tokens can be issued for this resource. It also schedules the on-start hook deployment.
2. **At container start**, the on-start dispatcher runs the deployed hook script. The hook:
   - lazy-installs `oauth2-proxy` via the OS package manager (apk community / apt backports);
   - detects whether `/etc/ssl/addon/{fullchain,privkey}.pem` are present and starts oauth2-proxy in **HTTPS** mode if so, otherwise **HTTP**;
   - sets iptables rules so the application's internal port accepts only loopback traffic (= only oauth2-proxy can reach it);
   - launches `oauth2-proxy` in the background with `--skip-jwt-bearer-tokens=true`, `--extra-jwt-issuers=<zitadel>=<audience>`.

For HTTPS to work the application should also have `addon-ssl` enabled (recommended for any cluster-public endpoint). Without addon-ssl the hook falls back to HTTP — the iptables rule still blocks cluster-internal direct access to the app port.

## Parameters

### `bearer_audience` (required)

The OAuth2 audience claim that issued JWTs must carry. By convention, use the application's hostname or a short slug (`gptwol`, `pve-status-api`). The addon creates an API application with this name in Zitadel; tokens must request this audience in their scope.

### `bearer_listen_port` (default: `8443`)

External port the oauth2-proxy listens on. nginx-vhost / external consumers point here. Make sure it doesn't collide with the application's own ports.

### `bearer_upstream_port` (default: `{{ http_port }}`)

The application's internal HTTP port. oauth2-proxy proxies validated requests to `127.0.0.1:<bearer_upstream_port>`. Defaults to the application's standard `http_port` property.

## Consuming the Addon

Enable in an application's `application.json`:

```json
"supported_addons": ["addon-oauth2-proxy", "addon-ssl"]
```

Then the application gains an external listener on `bearer_listen_port` (8443 by default) that requires `Authorization: Bearer <JWT>` with `aud=<bearer_audience>`. The application's own port (e.g. 5000) becomes loopback-only.

## Token Acquisition (Caller Side)

Callers (typically a CI workflow or a service) authenticate to Zitadel via the OAuth2 client_credentials grant:

```bash
JWT=$(curl -sS -X POST https://auth.ohnewarum.de/oauth/v2/token \
    -u "$CLIENT_ID:$CLIENT_SECRET" \
    -d "grant_type=client_credentials&scope=openid urn:zitadel:iam:org:project:id:$PROJECT_ID:aud" \
    | jq -r .access_token)

curl -H "Authorization: Bearer $JWT" https://target.ohnewarum.de/api/...
```

`CLIENT_ID` + `CLIENT_SECRET` belong to a Zitadel machine user that has been granted the appropriate role on the audience created by this addon.

## Behaviour Notes

- **Idempotent on container restart**: the hook checks `pgrep -x oauth2-proxy` and exits early if already running. Lazy-install is also idempotent.
- **HTTPS auto-detection**: presence of cert files at `/etc/ssl/addon/` switches oauth2-proxy to TLS mode. Adding/removing addon-ssl + reconfigure picks up the new mode on next container start.
- **No persistent secret in the LXC**: oauth2-proxy validates JWTs locally against Zitadel's public JWKS (cached). The hook generates a random `cookie_secret` on each start (not used for JWT-only flow but required by oauth2-proxy).
- **Defense in depth**: if the app's process binds to `0.0.0.0`, the iptables rule still blocks external cluster traffic to the internal port — only loopback (from oauth2-proxy in the same LXC) gets through.

## Out of Scope (Future Extensions)

- Browser-flow OIDC for apps with no native auth (`bearer_mode=browser-only` or `browser-and-jwt`)
- Per-role authorization beyond audience matching
- mTLS-bearer hybrid (combine with addon-mtls for client-cert + JWT)
