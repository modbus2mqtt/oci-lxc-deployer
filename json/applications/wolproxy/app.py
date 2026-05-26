"""wolproxy — minimal WoL/ping service.

Two endpoints, all idempotent, all UDP-broadcast or ICMP only:
  POST /wake?mac=AA:BB:CC:DD:EE:FF[&broadcast=192.168.1.255][&port=9]
    -> sends Magic Packet via UDP broadcast
    -> {"sent": true, "mac": "...", "broadcast": "...", "port": 9}

  GET  /status?ip=192.168.1.42
    -> ping -c1 -W2 <ip>
    -> {"status": "awake"} or {"status": "asleep"}

  GET  /health
    -> {"status": "ok"}

Shutdown is intentionally NOT a wolproxy concern. Workflows that need
to power down a host call PVE REST directly:
  POST https://<pve-host>:8006/api2/json/nodes/<node>/status
       command=shutdown
       Authorization: PVEAPIToken=...
That keeps wolproxy a pure WoL+ping shim with zero credentials of its own.

Auth is the caller's responsibility — in production, addon-oauth2-proxy
validates Bearer JWTs before the request reaches this service. For local
validation runs (validate-wolproxy.sh) auth is off.
"""

from flask import Flask, request, jsonify
import socket
import subprocess

app = Flask(__name__)


def _normalize_mac(mac: str) -> str:
    """Strip separators and lowercase; returns 12-char hex string."""
    hex_only = mac.replace(":", "").replace("-", "").lower()
    if len(hex_only) != 12:
        raise ValueError(f"invalid MAC length: {mac!r}")
    int(hex_only, 16)  # raises ValueError on non-hex chars
    return hex_only


def _format_mac(hex_str: str) -> str:
    """Format 12-char hex string back to AA:BB:CC:DD:EE:FF."""
    return ":".join(hex_str[i:i+2] for i in range(0, 12, 2)).upper()


@app.post("/wake")
def wake():
    mac = request.args.get("mac")
    broadcast = request.args.get("broadcast", "255.255.255.255")
    port = int(request.args.get("port", "9"))
    if not mac:
        return jsonify(error="missing mac"), 400
    try:
        mac_hex = _normalize_mac(mac)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    pkt = b"\xff" * 6 + bytes.fromhex(mac_hex) * 16
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        s.sendto(pkt, (broadcast, port))
    finally:
        s.close()
    return jsonify(sent=True, mac=_format_mac(mac_hex), broadcast=broadcast, port=port)


@app.get("/status")
def status():
    ip = request.args.get("ip")
    if not ip:
        return jsonify(error="missing ip"), 400
    rc = subprocess.run(
        ["ping", "-c", "1", "-W", "2", ip],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode
    return jsonify(status="awake" if rc == 0 else "asleep", ip=ip)


@app.get("/health")
def health():
    return jsonify(status="ok")
