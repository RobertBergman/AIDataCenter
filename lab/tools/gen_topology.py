"""Render docker-compose.fabric.yml from the cable plan.

One Docker bridge per cable, one service per device. Because this is generated from
sot/cabling.yml, re-cabling the fabric means editing YAML and re-rendering -- the same
loop a real fabric-as-code pipeline runs, minus the field engineer.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import yaml

import sotlib as sot

LAB = Path(__file__).resolve().parent.parent
OUT = LAB / "docker-compose.fabric.yml"

# Which switch personality the fabric is built from. The cabling, addressing, seed and
# compute nodes are identical either way -- only what runs on the switches changes.
PROFILE = os.environ.get("AIDC_PROFILE", "sonic")

# Highest priority attaches first, so the OOB network is always eth0 and the fabric
# links follow. The entrypoints re-verify this by MAC rather than trusting it.
OOB_PRIORITY = 1000


def build() -> dict:
    networks: dict[str, dict] = {
        # Created by docker-compose.seed.yml; the fabric joins it.
        "oob": {"external": True, "name": "aidc-oob"},
    }
    services: dict[str, dict] = {}

    for link in sot.LINKS:
        networks[link.net_name] = {
            "name": f"aidc-{link.id}",
            "driver": "bridge",
            # NOT `internal: true`. An internal network makes Docker install isolation
            # rules that drop IP traffic whose addresses fall outside the bridge's own
            # subnet. Docker's IPAM subnet here (172.30.x/24) exists only to satisfy the
            # bridge driver -- the traffic that matters is the fabric's own 10.x
            # addressing, which those rules silently discard. ARP still crosses (it is not
            # IP), so the fabric looks alive: neighbours resolve, and nothing else works.
            "driver_opts": {
                # Jumbo frames end to end: an AI fabric that silently falls back to
                # 1500 fragments every RDMA transfer.
                "com.docker.network.driver.mtu": str(sot.FABRIC["defaults"]["fabric_mtu"]),
            },
            "ipam": {"config": [{"subnet": link.net_subnet}]},
        }

    for dev in sot.DEVICES.values():
        net_block: dict[str, dict] = {
            "oob": {
                "mac_address": dev.mgmt_mac,
                "priority": OOB_PRIORITY,
                "gw_priority": OOB_PRIORITY,
            }
        }
        # Descending priority fixes Docker's attach order, so interface N is always the
        # Nth cable in the plan.
        #
        # Deliberately NO mac_address on fabric links. Assigning one makes Docker install a
        # static FDB entry for that endpoint and stop learning on the port, so any frame
        # whose destination is a different MAC becomes unknown unicast and is dropped. A
        # router sources every frame from one system MAC across all its ports, so pinning
        # per-port MACs silently blackholes the entire fabric -- ARP resolves, nothing else
        # passes. The OOB port keeps its MAC because DHCP identity depends on it, and there
        # the container MAC and the frame's source MAC are the same.
        for link, local, _remote in sot.links_for(dev.name):
            net_block[link.net_name] = {"priority": OOB_PRIORITY - local.ifindex}

        if dev.is_switch and PROFILE == "frr":
            services[dev.name] = {
                "build": {"context": "./nodes", "dockerfile": "frr/Dockerfile"},
                "image": "aidc-frr-ztp:latest",
                "container_name": dev.name,
                "hostname": dev.name,
                # Needed to create bridges, enslave ports and set forwarding sysctls.
                "privileged": True,
                "environment": {
                    "LAB_HINT_NAME": dev.name,
                    "SEED_FALLBACK": sot.IPAM["oob_management"]["seed"],
                    "SYSLOG_SERVER": sot.IPAM["oob_management"]["seed"],
                },
                "volumes": [f"./out/state/{dev.name}:/ztp-state"],
                "networks": net_block,
                "restart": "no",
                "healthcheck": {
                    "test": ["CMD-SHELL", "test -f /ztp-state/ztp-complete"],
                    "interval": "10s",
                    "timeout": "5s",
                    "retries": 60,
                    "start_period": "10s",
                },
            }
        elif dev.is_switch:
            services[dev.name] = {
                "build": {
                    "context": "./nodes",
                    "dockerfile": "switch/Dockerfile",
                    "args": {"SONIC_IMAGE": "${SONIC_IMAGE:-docker-sonic-vs:latest}"},
                },
                "image": "aidc-sonic-ztp:latest",
                "container_name": dev.name,
                "hostname": dev.name,
                # sonic-vs needs full privileges to program the virtual ASIC.
                "privileged": True,
                # The image entrypoint deliberately does NOT start SONiC straight away:
                # start.sh derives the front-panel port list from the interfaces present
                # at that moment, so every cable must be attached first.
                "environment": {
                    # Label only -- the device's real identity comes from its DHCP lease.
                    "LAB_HINT_NAME": dev.name,
                    "SEED_FALLBACK": sot.IPAM["oob_management"]["seed"],
                    "SYSLOG_SERVER": sot.IPAM["oob_management"]["seed"],
                },
                "volumes": [f"./out/state/{dev.name}:/ztp-state"],
                "networks": net_block,
                "restart": "no",
                "healthcheck": {
                    "test": ["CMD-SHELL", "test -f /ztp-state/ztp-complete"],
                    "interval": "10s",
                    "timeout": "5s",
                    "retries": 60,
                    "start_period": "30s",
                },
            }
        else:
            services[dev.name] = {
                "build": {"context": "./nodes", "dockerfile": "gpu/Dockerfile"},
                "image": "aidc-gpu-node:latest",
                "container_name": dev.name,
                "hostname": dev.name,
                "cap_add": ["NET_ADMIN", "NET_RAW", "SYS_ADMIN"],
                "environment": {
                    "LAB_HINT_NAME": dev.name,
                    "SEED_FALLBACK": sot.IPAM["oob_management"]["seed"],
                    "SYSLOG_SERVER": sot.IPAM["oob_management"]["seed"],
                    "GPU_COUNT": str(dev.gpus or 0),
                },
                "volumes": [f"./out/state/{dev.name}:/ztp-state"],
                "networks": net_block,
                "restart": "no",
                "healthcheck": {
                    "test": ["CMD-SHELL", "test -f /ztp-state/ztp-complete"],
                    "interval": "10s",
                    "timeout": "5s",
                    "retries": 60,
                    "start_period": "10s",
                },
            }

    return {"name": "aidc-lab", "services": services, "networks": networks}


def main() -> None:
    global PROFILE
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", choices=["sonic", "frr"], default=PROFILE)
    PROFILE = ap.parse_args().profile

    doc = build()
    header = (
        "# GENERATED FILE -- do not edit.\n"
        "# Rendered from sot/cabling.yml + sot/fabric.yml by tools/gen_topology.py\n"
        f"# profile: {PROFILE} -- {len(doc['services'])} devices, {len(sot.LINKS)} cables.\n"
    )
    OUT.write_text(header + yaml.safe_dump(doc, sort_keys=False, width=100), encoding="utf-8", newline="\n")

    for dev in sot.DEVICES:
        (LAB / "out" / "state" / dev).mkdir(parents=True, exist_ok=True)

    print(f"wrote {OUT}")
    print(f"  profile  : {PROFILE}")
    print(f"  services : {len(doc['services'])}")
    print(f"  networks : {len(doc['networks'])} (1 oob + {len(sot.LINKS)} cables)")


if __name__ == "__main__":
    main()
