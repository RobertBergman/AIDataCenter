"""Seed node ZTP service.

Answers the one question a booting device asks -- "who am I and what should I be
running?" -- and records the answer so the fleet's provisioning state is observable
rather than assumed.

The device authenticates itself with nothing but its management MAC, which is exactly
the trust model real ZTP uses on an isolated OOB network. A MAC that is not in the
source of truth gets a 404 and increments an alarm counter; it does not get a config.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, jsonify, request

app = Flask(__name__)

ARTIFACT_DIR = Path(os.environ.get("ARTIFACT_DIR", "/artifacts"))
STATE_FILE = Path(os.environ.get("STATE_FILE", "/state/registrations.json"))
SEED_URL = os.environ.get("SEED_URL", "http://10.10.0.10:8080")

# Where each rendered artifact belongs on the target device. This is the only place the
# lab encodes NOS-specific filesystem layout.
DEST_MAP = {
    "config_db.json": "/etc/sonic/config_db.json",   # sonic profile
    "fabric.json": "/etc/aidc/fabric.json",          # frr profile
    "frr.conf": "/etc/frr/frr.conf",
    "node.json": "/etc/aidc/node.json",
}

_lock = threading.Lock()
_registrations: dict[str, dict] = {}
_unknown_macs: dict[str, int] = {}
_requests: dict[str, int] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_manifest() -> dict:
    """Re-read on every call so a re-render is picked up without restarting the seed."""
    path = ARTIFACT_DIR / "manifest.json"
    if not path.exists():
        return {"devices": {}, "by_mac": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def _persist() -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps(
            {"registrations": _registrations, "unknown_macs": _unknown_macs, "requests": _requests},
            indent=2,
        ),
        encoding="utf-8",
    )


@app.get("/ztp/ztp.json")
def ztp_descriptor():
    """The document DHCP option 67 points at."""
    mac = (request.args.get("mac") or request.headers.get("X-Device-MAC") or "").lower()
    manifest = load_manifest()

    name = manifest["by_mac"].get(mac)
    with _lock:
        _requests[mac] = _requests.get(mac, 0) + 1
        if not name:
            _unknown_macs[mac] = _unknown_macs.get(mac, 0) + 1
            _persist()

    if not name:
        app.logger.warning("ZTP request from unknown MAC %s (%s)", mac, request.remote_addr)
        return jsonify({"error": "unknown device", "mac": mac}), 404

    entry = manifest["devices"][name]
    configs = [
        {
            "url": f"{SEED_URL}/artifacts/{name}/{fname}",
            "dest": DEST_MAP[fname],
            "sha256": digest,
        }
        for fname, digest in entry["files"].items()
    ]

    app.logger.info("ZTP descriptor issued: %s -> %s (%s)", mac, name, request.remote_addr)
    return jsonify(
        {
            "hostname": name,
            "role": entry["role"],
            "mgmt_ip": entry["mgmt_ip"],
            "api": f"{SEED_URL}/ztp",
            "syslog": SEED_URL.split("//")[1].split(":")[0],
            "configs": configs,
            # Which cable is which interface. The device applies this before starting its
            # NOS -- port layout is assigned by the source of truth, not discovered locally.
            "link_map": entry["link_map"],
            "expected_lldp": entry["expected_lldp"],
            "issued_at": _now(),
        }
    )


@app.post("/ztp/register")
def register():
    """Devices report in once provisioning completes, giving the seed a live inventory."""
    body = request.get_json(force=True, silent=True) or {}
    host = body.get("hostname")
    if not host:
        return jsonify({"error": "hostname required"}), 400
    with _lock:
        _registrations[host] = {**body, "registered_at": _now(), "source_ip": request.remote_addr}
        _persist()
    app.logger.info("registered %s (%s)", host, body.get("ip"))
    return jsonify({"ok": True})


@app.get("/ztp/inventory")
def inventory():
    manifest = load_manifest()
    expected = set(manifest["devices"])
    with _lock:
        registered = dict(_registrations)
        unknown = dict(_unknown_macs)
    return jsonify(
        {
            "expected": sorted(expected),
            "registered": sorted(registered),
            "missing": sorted(expected - set(registered)),
            "unknown_macs": unknown,
            "detail": registered,
        }
    )


@app.get("/ztp/health")
def health():
    return jsonify({"ok": True, "artifacts": (ARTIFACT_DIR / "manifest.json").exists()})


@app.get("/metrics")
def metrics():
    """Prometheus exposition: provisioning is a first-class observable."""
    manifest = load_manifest()
    expected = manifest["devices"]
    with _lock:
        registered = dict(_registrations)
        unknown = dict(_unknown_macs)
        reqs = dict(_requests)

    out = [
        "# HELP aidc_ztp_devices_expected Devices defined in the source of truth",
        "# TYPE aidc_ztp_devices_expected gauge",
        f"aidc_ztp_devices_expected {len(expected)}",
        "# HELP aidc_ztp_devices_provisioned Devices that completed ZTP and registered",
        "# TYPE aidc_ztp_devices_provisioned gauge",
        f"aidc_ztp_devices_provisioned {len(registered)}",
        "# HELP aidc_ztp_unknown_mac_requests ZTP requests from MACs absent from the SoT",
        "# TYPE aidc_ztp_unknown_mac_requests counter",
        f"aidc_ztp_unknown_mac_requests {sum(unknown.values())}",
        "# HELP aidc_ztp_device_provisioned Per-device provisioning state",
        "# TYPE aidc_ztp_device_provisioned gauge",
    ]
    for name, entry in expected.items():
        state = 1 if name in registered else 0
        out.append(
            f'aidc_ztp_device_provisioned{{device="{name}",role="{entry["role"]}"}} {state}'
        )
    out.append("# HELP aidc_ztp_descriptor_requests ZTP descriptor requests by MAC")
    out.append("# TYPE aidc_ztp_descriptor_requests counter")
    for mac, n in reqs.items():
        out.append(f'aidc_ztp_descriptor_requests{{mac="{mac}"}} {n}')
    return Response("\n".join(out) + "\n", mimetype="text/plain")


if __name__ == "__main__":
    if STATE_FILE.exists():
        try:
            saved = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            _registrations.update(saved.get("registrations", {}))
            _unknown_macs.update(saved.get("unknown_macs", {}))
        except Exception:  # noqa: BLE001 - a corrupt state file must not block provisioning
            pass
    app.run(host="0.0.0.0", port=9095)
