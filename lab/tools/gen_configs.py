"""Golden config generation: source of truth -> per-device artifacts.

Renders, into out/artifacts/<device>/:
  switches   config_db.json   ports, MTU, VLANs, L3 interfaces, loopback, QoS/PFC/ECN
             frr.conf         eBGP underlay
  gpu nodes  node.json        rail addressing, MTU, routes, expected LLDP neighbours

Why two files for a switch: the sonic-vs image ships no bgpcfgd, so CONFIG_DB BGP
tables are never translated into FRR. Real SONiC hardware images do that translation;
here the seed renders FRR config directly. Both files come from the same SoT, which is
the property being proven -- no device is ever hand-configured.

  python gen_configs.py --source netbox    # NetBox is authoritative (default)
  python gen_configs.py --source yaml      # bypass NetBox, render straight from YAML
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import shutil
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined

import sotlib as sot

LAB = Path(__file__).resolve().parent.parent
ARTIFACTS = LAB / "out" / "artifacts"
PLATFORM_DIR = Path(__file__).resolve().parent / "platform"

PLATFORM = sot.FABRIC["defaults"]["switch_platform"]
HWSKU = sot.FABRIC["defaults"]["switch_hwsku"]
MTU = str(sot.FABRIC["defaults"]["fabric_mtu"])

jinja = Environment(
    loader=FileSystemLoader(LAB / "templates"),
    undefined=StrictUndefined,
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
)


def load_port_table() -> dict[str, dict]:
    """Ethernet<N> -> {lanes, alias, index, speed} from the platform's port_config.ini.

    The lane assignment is a property of the emulated platform, not of our design, so
    it is captured from the image rather than invented here. sonic-vs binds container
    interface N to the port whose lanes sit at row N of this file.
    """
    table: dict[str, dict] = {}
    path = PLATFORM_DIR / f"{HWSKU}.port_config.ini"
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, lanes, alias, index, speed = line.split()[:5]
        table[name] = {"lanes": lanes, "alias": alias, "index": index, "speed": speed}
    return table


PORT_TABLE = load_port_table()


# --------------------------------------------------------------------------- QoS


def qos_tables() -> dict:
    """Lossless-fabric QoS rendered into CONFIG_DB tables."""
    q = sot.QOS
    lossless = q["pfc"]["lossless_priorities"]
    ecn = q["ecn"]

    dscp_map = {str(k): str(v) for k, v in q["dscp_to_tc"].items()}
    tc_to_queue = {str(v): str(v) for v in q["dscp_to_tc"].values()}

    tables: dict = {
        "DSCP_TO_TC_MAP": {"AZURE": dscp_map},
        "TC_TO_QUEUE_MAP": {"AZURE": tc_to_queue},
        "TC_TO_PRIORITY_GROUP_MAP": {"AZURE": {str(v): str(v) for v in q["dscp_to_tc"].values()}},
        "WRED_PROFILE": {
            ecn["profile"]: {
                "wred_green_enable": "true",
                "wred_yellow_enable": "true",
                "wred_red_enable": "true",
                "ecn": "ecn_all",
                "green_min_threshold": str(ecn["green_min_threshold_kb"] * 1000),
                "green_max_threshold": str(ecn["green_max_threshold_kb"] * 1000),
                "green_drop_probability": str(ecn["green_drop_probability"]),
                "yellow_min_threshold": str(ecn["green_min_threshold_kb"] * 1000),
                "yellow_max_threshold": str(ecn["green_max_threshold_kb"] * 1000),
                "yellow_drop_probability": str(ecn["green_drop_probability"]),
                "red_min_threshold": str(ecn["green_min_threshold_kb"] * 1000),
                "red_max_threshold": str(ecn["green_max_threshold_kb"] * 1000),
                "red_drop_probability": str(ecn["green_drop_probability"]),
            }
        },
        "SCHEDULER": {},
        "PFC_WD": {},
    }

    for sch in q["scheduler"]:
        name = f"scheduler.{sch['queue']}"
        if sch["type"] == "STRICT":
            tables["SCHEDULER"][name] = {"type": "STRICT"}
        else:
            tables["SCHEDULER"][name] = {"type": sch["type"], "weight": str(sch["weight"])}

    tables["_lossless_priorities"] = ",".join(str(p) for p in lossless)
    tables["_ecn_queue"] = str(ecn["queue"])
    tables["_ecn_profile"] = ecn["profile"]
    return tables


def apply_port_qos(cfg: dict, ports: list[str]) -> None:
    """Attach the QoS maps, PFC and watchdog to every front-panel port."""
    q = sot.QOS
    qos = cfg["_qos"]
    lossless = qos["_lossless_priorities"]

    cfg["PORT_QOS_MAP"] = {
        p: {
            "dscp_to_tc_map": "AZURE",
            "tc_to_queue_map": "AZURE",
            "tc_to_pg_map": "AZURE",
            "pfc_enable": lossless,
        }
        for p in ports
    }

    cfg["QUEUE"] = {}
    for p in ports:
        for sch in q["scheduler"]:
            key = f"{p}|{sch['queue']}"
            entry = {"scheduler": f"scheduler.{sch['queue']}"}
            if str(sch["queue"]) == qos["_ecn_queue"]:
                entry["wred_profile"] = qos["_ecn_profile"]
            cfg["QUEUE"][key] = entry

    if q["pfc"]["watchdog"]["enabled"]:
        wd = q["pfc"]["watchdog"]
        cfg["PFC_WD"] = {
            p: {
                "action": wd["action"],
                "detection_time": str(wd["detection_time_ms"]),
                "restoration_time": str(wd["restoration_time_ms"]),
            }
            for p in ports
        }

    for tbl in ("DSCP_TO_TC_MAP", "TC_TO_QUEUE_MAP", "TC_TO_PRIORITY_GROUP_MAP",
                "WRED_PROFILE", "SCHEDULER"):
        cfg[tbl] = qos[tbl]


# ------------------------------------------------------------------- config_db


def render_config_db(dev: sot.Device, model) -> dict:
    cfg: dict = {
        "DEVICE_METADATA": {
            "localhost": {
                "hostname": dev.name,
                "hwsku": HWSKU,
                "platform": PLATFORM,
                "type": dev.sonic_type,
                "bgp_asn": str(dev.asn),
                "mac": dev.mgmt_mac,
            }
        },
        "PORT": {},
        "INTERFACE": {},
        "LOOPBACK_INTERFACE": {},
        "MGMT_PORT": {"eth0": {"admin_status": "up", "alias": "eth0", "description": "oob"}},
        "FEATURE": {},
    }

    ports: list[str] = []
    vlan_members: list[str] = []

    for link, local, remote in model.links_for(dev.name):
        port = local.port
        ports.append(port)
        meta = PORT_TABLE[port]
        cfg["PORT"][port] = {
            "lanes": meta["lanes"],
            "alias": meta["alias"],
            "index": meta["index"],
            "speed": meta["speed"],
            "mtu": MTU,
            "admin_status": "up",
            "description": f"to {remote.device} {remote.port} [{link.id}]",
        }
        if link.type == "fabric":
            # Routed point-to-point underlay link.
            cfg["INTERFACE"][port] = {}
            cfg["INTERFACE"][f"{port}|{local.ip}"] = {}
        else:
            # Host-facing rail port: an access port into the rail's L2 domain.
            vlan_members.append(port)

    # Loopback carries the BGP router-id and is what the fabric actually routes to.
    if dev.loopback:
        cfg["LOOPBACK_INTERFACE"]["Loopback0"] = {}
        cfg["LOOPBACK_INTERFACE"][f"Loopback0|{dev.loopback}"] = {}

    # A leaf terminates exactly one rail; that rail's gateway lives here and nowhere else.
    if dev.role == "leaf":
        rail = model.rail_for_leaf(dev.name)
        vlan = f"Vlan{rail['vlan']}"
        cfg["VLAN"] = {
            vlan: {"vlanid": str(rail["vlan"]), "mtu": MTU, "description": f"rail{rail['rail']}"}
        }
        cfg["VLAN_MEMBER"] = {
            f"{vlan}|{p}": {"tagging_mode": "untagged"} for p in vlan_members
        }
        cfg["VLAN_INTERFACE"] = {vlan: {}, f"{vlan}|{rail['gateway']}/{ipaddress.ip_network(rail['prefix']).prefixlen}": {}}

    cfg["_qos"] = qos_tables()
    apply_port_qos(cfg, ports)
    del cfg["_qos"]
    return cfg


def render_frr(dev: sot.Device, model) -> str:
    """eBGP underlay: every leaf peers both spines, ECMP across them."""
    neighbors = []
    for link, local, remote in model.links_for(dev.name):
        if link.type != "fabric":
            continue
        remote_dev = model.device(remote.device)
        neighbors.append(
            {
                "ip": str(ipaddress.ip_interface(remote.ip).ip),
                "asn": remote_dev.asn,
                "name": remote.device,
                "port": local.port,
            }
        )

    advertise = []
    if dev.loopback:
        advertise.append(dev.loopback)
    if dev.role == "leaf":
        advertise.append(model.rail_for_leaf(dev.name)["prefix"])

    return jinja.get_template("frr.conf.j2").render(
        device=dev,
        neighbors=sorted(neighbors, key=lambda n: n["ip"]),
        advertise=advertise,
        router_id=dev.loopback_addr,
    )


def render_fabric_json(dev: sot.Device, model) -> dict:
    """Switch config for the FRR profile: the same intent, expressed for a Linux data plane.

    Where the SONiC profile emits CONFIG_DB tables for an ASIC to program, this emits the
    bridges, routed interfaces and MTUs the kernel will actually forward with. Both are
    rendered from the same source of truth, so the two profiles are genuinely the same
    fabric built two ways.
    """
    ports = []
    bridge = None

    if dev.role == "leaf":
        rail = model.rail_for_leaf(dev.name)
        prefixlen = ipaddress.ip_network(rail["prefix"]).prefixlen
        bridge = {
            "name": f"Vlan{rail['vlan']}",
            "vlan": rail["vlan"],
            "rail": rail["rail"],
            "ip": f"{rail['gateway']}/{prefixlen}",
            "mtu": int(MTU),
        }

    for link, local, remote in model.links_for(dev.name):
        entry = {
            "name": local.port,
            "ifindex": local.ifindex,
            "mtu": int(MTU),
            "neighbor": remote.device,
            "neighbor_port": remote.port,
        }
        if link.type == "fabric":
            entry["mode"] = "routed"
            entry["ip"] = local.ip
        else:
            # Host-facing rail port: an access port into the leaf's rail bridge.
            entry["mode"] = "access"
            entry["bridge"] = bridge["name"] if bridge else None
        ports.append(entry)

    return {
        "hostname": dev.name,
        "role": dev.role,
        "asn": dev.asn,
        "loopback": dev.loopback,
        "mtu": int(MTU),
        "bridge": bridge,
        "ports": ports,
        "expected_lldp": model.expected_neighbors(dev.name),
    }


def render_node(dev: sot.Device, model) -> dict:
    """Config bundle for a GPU compute node."""
    rails = []
    for link, local, remote in model.links_for(dev.name):
        rail_id = link.rail
        rail = model.rail(rail_id)
        rails.append(
            {
                "rail": rail_id,
                "interface": local.port,
                "mac": local.mac,
                "address": model.rail_host_ip(dev, rail_id),
                "gateway": rail["gateway"],
                "mtu": int(MTU),
                "vlan": rail["vlan"],
                "leaf": remote.device,
                "leaf_port": remote.port,
                # The NIC that NCCL would pin to GPU k on this rail.
                "gpu": rail_id,
            }
        )

    return {
        "hostname": dev.name,
        "role": dev.role,
        "mgmt": {"address": dev.mgmt_ip, "mac": dev.mgmt_mac},
        "gpus": dev.gpus,
        "rails": sorted(rails, key=lambda r: r["rail"]),
        # Routes to every other rail subnet go via this node's own rail gateway.
        "rail_prefixes": {str(r["rail"]): r["prefix"] for r in sot.IPAM["rails"]},
        "expected_lldp": model.expected_neighbors(dev.name),
        "mtu": int(MTU),
    }


# ------------------------------------------------------------------------ main


def write_artifacts(model, out: Path, profile: str = "sonic") -> dict:
    # Clear the contents, never the directory itself. This path is bind-mounted into the
    # seed's HTTP server and ZTP API; replacing the directory swaps its inode and leaves
    # those containers mounted on the deleted one, so every artifact 404s until they are
    # recreated. Re-rendering must not require restarting the seed.
    out.mkdir(parents=True, exist_ok=True)
    for child in out.iterdir():
        shutil.rmtree(child) if child.is_dir() else child.unlink()

    manifest: dict = {"profile": profile, "devices": {}, "by_mac": {}}

    for dev in model.devices():
        ddir = out / dev.name
        ddir.mkdir(parents=True, exist_ok=True)
        files = {}

        if dev.is_switch and profile == "frr":
            fab = render_fabric_json(dev, model)
            (ddir / "fabric.json").write_text(json.dumps(fab, indent=2), encoding="utf-8", newline="\n")
            (ddir / "frr.conf").write_text(render_frr(dev, model), encoding="utf-8", newline="\n")
            files = {"fabric.json": None, "frr.conf": None}
        elif dev.is_switch:
            cdb = render_config_db(dev, model)
            (ddir / "config_db.json").write_text(json.dumps(cdb, indent=2), encoding="utf-8", newline="\n")
            (ddir / "frr.conf").write_text(render_frr(dev, model), encoding="utf-8", newline="\n")
            files = {"config_db.json": None, "frr.conf": None}
        else:
            node = render_node(dev, model)
            (ddir / "node.json").write_text(json.dumps(node, indent=2), encoding="utf-8", newline="\n")
            files = {"node.json": None}

        for fname in files:
            digest = hashlib.sha256((ddir / fname).read_bytes()).hexdigest()
            files[fname] = digest

        # Which Docker cable-network becomes which interface on this device. Keyed by the
        # third octet of the link subnet, which is the only stable handle Docker gives a
        # container for "which cable is this". Consumed by the ZTP agent before it starts
        # the NOS -- see nodes/common/ztp-lib.sh.
        link_map = {
            link.net_subnet.split(".")[2]: {"ifindex": local.ifindex, "port": local.port}
            for link, local, _remote in model.links_for(dev.name)
        }

        entry = {
            "hostname": dev.name,
            "role": dev.role,
            "mgmt_mac": dev.mgmt_mac,
            "mgmt_ip": dev.mgmt_ip,
            "files": files,
            "link_map": link_map,
            "expected_lldp": model.expected_neighbors(dev.name),
        }
        manifest["devices"][dev.name] = entry
        manifest["by_mac"][dev.mgmt_mac.lower()] = dev.name

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8", newline="\n")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["netbox", "yaml"], default="netbox")
    ap.add_argument("--profile", choices=["sonic", "frr"], default="sonic",
                    help="sonic: real NOS, control plane only. frr: real Linux data plane.")
    ap.add_argument("--out", default=str(ARTIFACTS))
    args = ap.parse_args()

    if args.source == "netbox":
        import netbox_source

        model = netbox_source.NetBoxModel()
    else:
        import yaml_source

        model = yaml_source.YamlModel()

    print(f"source of truth: {model.describe()}")
    print(f"switch profile : {args.profile}")
    manifest = write_artifacts(model, Path(args.out), args.profile)
    print(f"rendered {len(manifest['devices'])} device configs -> {args.out}")
    for name, entry in manifest["devices"].items():
        print(f"  {name:8s} {entry['role']:9s} {', '.join(entry['files'])}")


if __name__ == "__main__":
    main()
