# Homebridge

Lightweight server that emulates the iOS HomeKit API so non-HomeKit smart-home
devices become controllable from Apple Home and Siri, via Homebridge's large
plugin ecosystem. Runs as an OCI-image LXC container
(`homebridge/homebridge`). The **Config UI X** web interface — used to edit
`config.json`, install/configure plugins and read logs — listens on port
**8581**.

## HTTPS

Homebridge Config UI X serves the web interface over **plain HTTP** by default.
This application therefore exposes the UI on HTTP only. For TLS, put a reverse
proxy in front of it, or run it on a trusted LAN segment.

## HomeKit pairing & mDNS

HomeKit accessories are announced and discovered on the local network over
**mDNS / Bonjour**. Because the container sits directly on the LAN with its own
IP (unlike a NATed Docker bridge, which is why the upstream Docker image
requires `network_mode: host`), mDNS advertisement works without extra
configuration. Pair the bridge from the Apple Home app using the PIN shown on
the Config UI X status page.

## Storage

The `config` volume (mounted at `/homebridge`, default 4 GB) holds
`config.json`, the persisted accessory/pairing state and all installed
plugins with their Node modules — which grow as you add plugins, so size it
generously.

## Plugins needing native packages

Some plugins require extra apt packages (e.g. `ffmpeg` for camera plugins).
Add them via the image's `HOMEBRIDGE_APT_PACKAGES` environment variable — set
it in the application's **Environment** parameter (space-separated package
list) and reconfigure.
