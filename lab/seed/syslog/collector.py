"""Seed node syslog collector.

Devices ship their ZTP progress and NOS logs here from the moment they get a lease --
before that they have no address and no way to tell anyone anything. That gap is exactly
why the seed is the one machine you install by hand.

Kept deliberately small: it writes a flat log the verification suite can grep and exposes
per-device counters to Prometheus.
"""

from __future__ import annotations

import os
import re
import socketserver
import threading
from collections import defaultdict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

STATE = Path(os.environ.get("STATE_DIR", "/state"))
LOGFILE = STATE / "syslog.log"
BIND_PORT = int(os.environ.get("SYSLOG_PORT", "514"))
METRICS_PORT = int(os.environ.get("METRICS_PORT", "9101"))

# <PRI>TIMESTAMP HOST TAG: MESSAGE
SYSLOG_RE = re.compile(r"^<(?P<pri>\d+)>(?P<ts>\w{3}\s+\d+\s[\d:]+)\s(?P<host>\S+)\s(?P<rest>.*)$")

_lock = threading.Lock()
_counts: dict[str, int] = defaultdict(int)
_severities: dict[str, int] = defaultdict(int)


class SyslogHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        raw = self.request[0].decode("utf-8", errors="replace").rstrip()
        src = self.client_address[0]

        host, message, severity = src, raw, "info"
        m = SYSLOG_RE.match(raw)
        if m:
            host = m.group("host")
            message = m.group("rest")
            severity = str(int(m.group("pri")) & 0x07)

        with _lock:
            _counts[host] += 1
            _severities[severity] += 1

        line = f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {src} {host} {message}\n"
        with open(LOGFILE, "a", encoding="utf-8") as fh:
            fh.write(line)
        print(line, end="", flush=True)


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        with _lock:
            counts = dict(_counts)
            sev = dict(_severities)
        body = [
            "# HELP aidc_syslog_messages_total Syslog messages received per device",
            "# TYPE aidc_syslog_messages_total counter",
        ]
        body += [f'aidc_syslog_messages_total{{host="{h}"}} {n}' for h, n in counts.items()]
        body += [
            "# HELP aidc_syslog_devices_reporting Devices that have sent at least one message",
            "# TYPE aidc_syslog_devices_reporting gauge",
            f"aidc_syslog_devices_reporting {len(counts)}",
            "# HELP aidc_syslog_by_severity Messages by syslog severity",
            "# TYPE aidc_syslog_by_severity counter",
        ]
        body += [f'aidc_syslog_by_severity{{severity="{s}"}} {n}' for s, n in sev.items()]
        payload = ("\n".join(body) + "\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args) -> None:
        pass


def main() -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    LOGFILE.touch(exist_ok=True)

    threading.Thread(
        target=lambda: HTTPServer(("0.0.0.0", METRICS_PORT), MetricsHandler).serve_forever(),
        daemon=True,
    ).start()

    print(f"syslog collector listening on udp/{BIND_PORT}, metrics on {METRICS_PORT}", flush=True)
    with socketserver.ThreadingUDPServer(("0.0.0.0", BIND_PORT), SyslogHandler) as srv:
        srv.serve_forever()


if __name__ == "__main__":
    main()
