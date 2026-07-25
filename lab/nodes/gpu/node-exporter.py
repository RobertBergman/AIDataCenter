"""Compute-node telemetry exporter.

Two kinds of metric, because in an AI fabric they are only useful together:

  * real per-rail NIC counters read from /sys -- bytes, packets, drops, and the MTU the
    interface is actually running (not the one someone intended);
  * a DCGM-shaped GPU metric set, simulated, so the dashboard can show the correlation an
    operator actually looks for: which GPU stalled and which rail was congested when it did.

The GPU numbers are synthetic and labelled as such. The network numbers are not.
"""

from __future__ import annotations

import json
import math
import os
import random
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

NODE_CFG = Path(os.environ.get("NODE_CFG", "/etc/aidc/node.json"))
PORT = int(os.environ.get("EXPORTER_PORT", "9200"))
START = time.time()

CFG = json.loads(NODE_CFG.read_text(encoding="utf-8"))
HOST = CFG["hostname"]
RAILS = CFG["rails"]


def read_stat(iface: str, name: str) -> int:
    try:
        return int(Path(f"/sys/class/net/{iface}/statistics/{name}").read_text().strip())
    except (OSError, ValueError):
        return 0


def read_attr(iface: str, name: str) -> int:
    try:
        return int(Path(f"/sys/class/net/{iface}/{name}").read_text().strip())
    except (OSError, ValueError):
        return 0


def iface_up(iface: str) -> int:
    try:
        return 1 if Path(f"/sys/class/net/{iface}/operstate").read_text().strip() == "up" else 0
    except OSError:
        return 0


def collect() -> str:
    now = time.time() - START
    out: list[str] = []

    def add(help_: str, type_: str, name: str, samples: list[str]) -> None:
        out.append(f"# HELP {name} {help_}")
        out.append(f"# TYPE {name} {type_}")
        out.extend(samples)

    # ---- real NIC counters, one series per rail ----------------------------
    for spec in ["rx_bytes", "tx_bytes", "rx_packets", "tx_packets", "rx_dropped", "tx_dropped"]:
        add(
            f"Rail interface {spec}",
            "counter",
            f"aidc_rail_{spec}",
            [
                f'aidc_rail_{spec}{{node="{HOST}",rail="{r["rail"]}",iface="{r["interface"]}",'
                f'leaf="{r["leaf"]}"}} {read_stat(r["interface"], spec)}'
                for r in RAILS
            ],
        )

    # MTU is exported because a rail that silently came up at 1500 is the single most
    # common cause of "the fabric is fine but training is slow".
    add(
        "Rail interface MTU as currently programmed",
        "gauge",
        "aidc_rail_mtu",
        [
            f'aidc_rail_mtu{{node="{HOST}",rail="{r["rail"]}",iface="{r["interface"]}"}} '
            f"{read_attr(r['interface'], 'mtu')}"
            for r in RAILS
        ],
    )
    add(
        "Rail interface operational state",
        "gauge",
        "aidc_rail_up",
        [
            f'aidc_rail_up{{node="{HOST}",rail="{r["rail"]}",iface="{r["interface"]}",'
            f'leaf="{r["leaf"]}"}} {iface_up(r["interface"])}'
            for r in RAILS
        ],
    )
    add(
        "Rail interface expected MTU from the source of truth",
        "gauge",
        "aidc_rail_mtu_intended",
        [
            f'aidc_rail_mtu_intended{{node="{HOST}",rail="{r["rail"]}"}} {r["mtu"]}'
            for r in RAILS
        ],
    )

    # ---- simulated GPU telemetry ------------------------------------------
    gpus = CFG.get("gpus") or 0
    util, temp, power, stall = [], [], [], []
    for g in range(gpus):
        phase = now / 20.0 + g * 0.7
        base = 82 + 14 * math.sin(phase)
        u = max(0.0, min(100.0, base + random.uniform(-3, 3)))
        util.append(f'aidc_gpu_utilization{{node="{HOST}",gpu="{g}",simulated="true"}} {u:.1f}')
        temp.append(
            f'aidc_gpu_temperature_celsius{{node="{HOST}",gpu="{g}",simulated="true"}} '
            f"{58 + u * 0.22:.1f}"
        )
        power.append(
            f'aidc_gpu_power_watts{{node="{HOST}",gpu="{g}",simulated="true"}} {250 + u * 4.2:.0f}'
        )
        # The metric that matters: time a GPU spent waiting on a collective. It is what
        # a mis-cabled rail or a congested queue actually costs.
        stall.append(
            f'aidc_gpu_collective_wait_seconds{{node="{HOST}",gpu="{g}",rail="{g % max(1, len(RAILS))}",'
            f'simulated="true"}} {max(0.0, (100 - u) * 0.011):.4f}'
        )

    add("GPU utilisation percent (simulated)", "gauge", "aidc_gpu_utilization", util)
    add("GPU temperature (simulated)", "gauge", "aidc_gpu_temperature_celsius", temp)
    add("GPU power draw (simulated)", "gauge", "aidc_gpu_power_watts", power)
    add(
        "Seconds a GPU spent blocked in a collective (simulated)",
        "gauge",
        "aidc_gpu_collective_wait_seconds",
        stall,
    )

    add(
        "Node provisioned by the seed and reporting",
        "gauge",
        "aidc_node_up",
        [f'aidc_node_up{{node="{HOST}",role="{CFG["role"]}"}} 1'],
    )
    return "\n".join(out) + "\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        if self.path.startswith("/metrics"):
            payload = collect().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            body = f"{HOST} node exporter\n/metrics\n".encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *_args) -> None:
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
