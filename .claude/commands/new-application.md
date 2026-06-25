Scaffold a new proxvex LXC application. In most cases this means just three files — `application.json`, a small `icon`, and `application.md` — plus an image-version pin. Bakes in the gotchas that bite every new app.

## Usage

The user provides: `$ARGUMENTS`
Format: `<app-name> [<oci-image-ref>] [--ssl native] [--serial] [--production]`

Examples:
- `homebridge homebridge/homebridge` — HTTP-only OCI app (the common case)
- `frigate ghcr.io/blakeblackshear/frigate --ssl native --serial` — native HTTPS + USB serial
- `paperless ghcr.io/paperless-ngx/paperless-ngx --production` — also wire a production deploy step

If `$ARGUMENTS` is empty, ask for: app name, OCI image reference, web UI port, whether the UI speaks native HTTPS, and whether it needs a USB/serial device. Then proceed.

## The common case — three files, nothing more

A directory `json/applications/<app>/` with:
- **`application.json`** — config (`extends: "oci-image"`, `properties[]`, metadata).
- **`icon.png`** (or `.svg`) — small logo, ~420×420.
- **`application.md`** — human docs (always write this).

That's it for the large majority of services. The `oci-image` base already provides the **entire** install/upgrade/reconfigure/check lifecycle — a new app normally only sets `properties[]`. Adding `scripts/` or `templates/` to an app dir is the **exception** (postgres, zitadel, nginx, the mirrors) — don't create them unless the app genuinely needs custom steps.

Before writing, read the closest sibling: `homebridge`/`esphome` (HTTP-only), `zigbee2mqtt`/`node-red` (native HTTPS), `gptwol`/`wolproxy` (small). Match key order and conventions; don't invent fields.

This project does NOT run Docker — proxvex parses the OCI image and creates an LXC. Ignore Docker-only concepts (`network_mode`, `deploy.resources`, socket mounts).

## `application.json` — the property checklist

| Property | Notes |
|---|---|
| `hostname` | `default` = the app name |
| **`disk_size`** | **⚠️ MUST set explicitly.** Default is **`0.5` (GB)** — too small for anything but tiny Alpine images. Small Alpine ~`1`, Debian/Node/Python ~`4`, build-heavy `8`–`16`. Too small → OCI extract fails with `Disk quota exceeded (os error 122)`. Rule of thumb: compressed tar ×3–4 ≈ extracted rootfs. |
| `volumes` | persistent data, e.g. `config=/config,size=4G`. Grows over time — size generously. Add `certs=/ssl` if native SSL. |
| `envs` | `TZ=Europe/Berlin` plus app env (e.g. a `*_PORT`) |
| `rootfs_storage` | `local-zfs` |
| `volume_storage` | `local-zfs`, `required: true` |
| `oci_image` | `value`: `<repo>/<image>:{{oci_image_tag}}` |
| `wait_for_network` | `value: "true"` |
| `uid`/`gid`/`username` | match the image's runtime user; root images use `0`/`0`/`root` |
| `http_port` | web UI port for **HTTP-only** apps (drives notes/links + health check) |
| `local_https_port` + `ssl_mode: native` + `ssl.needs_server_cert`/`ssl.needs_ca_cert` | only for apps with **native HTTPS** (see `zigbee2mqtt`/`node-red`) |
| `volume_backup` | `value: "true"` |

HTTP-only vs native HTTPS: most dashboards have no TLS → serve HTTP only (`http_port`) and say so in the `.md`. Only use the native-SSL props when the app itself terminates TLS.

Metadata: `name`, `description` (what it is + that it runs as an LXC), `extends: "oci-image"`, `icon`, `tags` (reuse existing: `automation`, `iot`, `database`, `infrastructure`, `api`, `development`), `supported_addons` (`[]` if none), `url`, `documentation`, `source`.

Every property `id` must exist in `json/shared/parameter-definitions.json` (or be a known base property) — unknown ids silently do nothing.

## The other two files

- **`icon`**: fetch the project logo and resize — `sips -z 420 420 <src>.png --out json/applications/<app>/icon.png`.
- **`application.md`**: document HTTPS posture (HTTP-only vs native), any pairing/discovery (mDNS, HomeKit, serial), and storage sizing. Keep it concrete and short.
- **`tests/default.json`** (write one too):
  ```json
  { "params": [ { "name": "oci_image_tag", "value": "latest" } ],
    "wait_seconds": 60,
    "description": "Install <app> without addons; smoke test that the container starts and the UI comes up." }
  ```

## Pin the image version — `json/shared/scripts/library/versions.sh`

Add under `# --- OCI Image Apps ---`:
`OCI_<app>_TAG="${OCI_<app>_TAG:-latest}"   # <repo>/<image>`
and append `OCI_<app>_TAG` to the matching `export` line. The `# <image-url>` comment is parsed to pre-pull the image for livetests. Use underscores (`OCI_node_red_TAG`).

## Validate

```
cd backend && pnpm run lint:json
```
(the pre-commit hook runs this too). Must list your app under `Applications (N)` and your tag under `Image Versions`. Fix any schema error before committing.

## Deploy / update on the cluster

- **Update the JSON on a live deployer (no redeploy):** `production/setup-production.sh --json-dev-sync` copies the local `json/` tree into the deployer container and `POST /api/reload`. The deployer picks up changed `application.json`/templates **without a rebuild and without touching running containers** — use this to push a definition fix (e.g. a corrected `disk_size`) to an app that already runs. Combine with `--retry`/`--step` only if you also want to redeploy.
- **Verify a new app live (preferred):** `/livetest <app>/default` — reproduces the real deploy in the nested VM, where `disk_size`/image issues surface safely. Deploy to production only after a green livetest.

## Rare extras (only when actually needed)

- **Serial/USB device:** append `"110-conf-map-serial.json"` to `installation`/`upgrade`/`reconfigure` `pre_start` (shared template; see `esphome`/`zigbee2mqtt`). Otherwise omit lifecycle blocks entirely — `extends` **merges** phases, so defining only `pre_start` appends to the base, it does not replace the rest.
- **First-class production app (`--production`):** create `production/<app>.json` (`{ "application": "<app>", "task": "installation", "params": [ { "name": "vm_id_start", "value": 600 }, { "name": "oci_image_tag", "value": "latest" } ], "selectedAddons": [] }`) and mirror the last step in `setup-production.sh` (menu line in `print_steps()`, a `should_run N` block calling `deploy.sh --host "$(host_for_app <app>)" <app>.json`, summary `echo`). Non-default host → add `<app>=<host>` to `APP_HOST_MAP`. Don't touch the `--retry` map (curated, stateless steps only).
- **Custom scripts:** POSIX `sh`, stdout JSON-only, logs to stderr, never `2>&1` (see CLAUDE.md).

## Hard-won gotchas (do not relearn these)

- **`disk_size` default `0.5 GB`** is the #1 footgun — esphome and homebridge both failed production deploys with `Disk quota exceeded` until `disk_size` was set. Always set it.
- **`extends` merges lifecycle phases** — don't copy the whole base lifecycle into the app; set only what differs.
- **`http_port` vs `local_https_port`** decides HTTP vs HTTPS health checks — wrong choice fails the check even though the app is up.
- **An app is "registered" by its directory** (+ versions.sh pin, + optional production wiring). There is no central app index to edit.
