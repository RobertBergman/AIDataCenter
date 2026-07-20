#!/usr/bin/env python3
"""Arista ZTP bootstrap script — runs ON the switch, executed by EOS ZTP.

Flow (SPEC §5.10 / docs/network.md §3):
  1. Switch boots with no startup-config → EOS ZTP sends DHCPDISCOVER
     (Management1, and any front-panel port with link — used for zero-day
     bench bring-up of the OOB pair).
  2. dnsmasq on seed01 answers (reservation by Ma1 MAC, or dynamic pool on
     the bench) and returns option 67 = http://<seed>/ztp/ztp.py.
  3. EOS downloads and executes THIS script with the system Python.
  4. Script identifies itself by SERIAL NUMBER, fetches its rendered
     startup-config from the seed, optionally stages the target EOS image,
     writes startup-config, disables ZTP, reloads.

The config inventory is rendered by bootstrap/seed/ztp/render.py from
NetBox/seed data (serial → hostname map: bootstrap/seed/ztp/serialmap.yaml).

Validate against the target EOS release's ZTP chapter before production;
the mechanisms below are stable across EOS 4.x (zerotouch-config DISABLE,
FastCli, /mnt/flash paths), but command output parsing is best-effort.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
import time
import urllib.request

# seed01 nginx (dnsmasq hands this URL out via DHCP option 67)
SERVER = "http://10.10.0.10/ztp"

STARTUP_CONFIG = "/mnt/flash/startup-config"
ZTP_CONFIG = "/mnt/flash/zerotouch-config"
BOOT_CONFIG = "/mnt/flash/boot-config"


def cli(cmd: str) -> str:
    """Run one EOS CLI command and return stdout text."""
    out = subprocess.run(
        ["FastCli", "-p", "15", "-c", cmd],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return out.stdout


def get_serial() -> str:
    m = re.search(r"Serial number:\s*(\S+)", cli("show version"))
    if not m:
        sys.exit("ztp: could not determine serial number")
    return m.group(1)


def fetch(url: str, timeout: int = 120) -> bytes:
    last = None
    for attempt in range(5):
        try:
            return urllib.request.urlopen(url, timeout=timeout).read()
        except Exception as e:  # noqa: BLE001 — retry transient seed/relay races
            last = e
            time.sleep(2**attempt)
    sys.exit(f"ztp: fetch failed {url}: {last}")


def main() -> None:
    serial = get_serial()
    log(f"ztp: serial={serial} — fetching config")

    cfg = fetch(f"{SERVER}/configs/{serial}").decode()

    # Optional image staging: first line `!IMAGE: <file> <sha512>`
    first = cfg.splitlines()[0] if cfg else ""
    if first.startswith("!IMAGE:"):
        _, fname, want_sha = first.split()
        if fname not in cli("dir flash:"):
            log(f"ztp: staging EOS image {fname}")
            blob = fetch(f"{SERVER}/images/{fname}", timeout=3600)
            got = hashlib.sha512(blob).hexdigest()
            if got != want_sha:
                sys.exit(f"ztp: image sha512 mismatch {got} != {want_sha}")
            with open(f"/mnt/flash/{fname}", "wb") as f:
                f.write(blob)
        with open(BOOT_CONFIG, "w", encoding="utf-8") as f:
            f.write(f"SWI=flash:{fname}\n")

    with open(STARTUP_CONFIG, "w", encoding="utf-8") as f:
        f.write(cfg)

    # Exit ZTP permanently, then reload into the real config.
    with open(ZTP_CONFIG, "w", encoding="utf-8") as f:
        f.write("DISABLE=True\n")

    log("ztp: config installed — reloading")
    subprocess.run(["/sbin/reboot"], check=False)


def log(msg: str) -> None:
    print(msg, flush=True)
    try:
        with open("/mnt/flash/ztp.log", "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {msg}\n")
    except OSError:
        pass


if __name__ == "__main__":
    main()
