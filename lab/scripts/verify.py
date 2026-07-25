#!/usr/bin/env python3
"""End-to-end proof that the seed provisioned the pod.

Runs from the host against the live containers and checks what was actually achieved,
not what was attempted. Every check states what it proves; failures print the observed
value so the report is useful without re-running anything by hand.

    python scripts/verify.py              # full run
    python scripts/verify.py --quick      # skip the slower reachability checks
    python scripts/verify.py --json out.json

Exit code is non-zero if any check fails, so CI can gate on it.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent
MANIFEST = LAB / "out" / "artifacts" / "manifest.json"
SEED = "http://localhost:8080"

RESET, BOLD = "\033[0m", "\033[1m"
GREEN, RED, YELLOW, DIM = "\033[32m", "\033[31m", "\033[33m", "\033[2m"

results: list[dict] = []


def docker(container: str, *cmd: str, timeout: int = 30) -> tuple[int, str]:
    try:
        p = subprocess.run(
            ["docker", "exec", container, *cmd],
            capture_output=True, text=True, timeout=timeout,
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "timeout"
    except FileNotFoundError:
        sys.exit("docker CLI not found on PATH")


def http(path: str, timeout: int = 10) -> str | None:
    try:
        with urllib.request.urlopen(f"{SEED}{path}", timeout=timeout) as r:
            return r.read().decode()
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def check(section: str, name: str, ok: bool, detail: str = "", proves: str = "",
          skipped: bool = False) -> bool:
    results.append({"section": section, "name": name, "ok": bool(ok),
                    "detail": detail, "proves": proves, "skipped": skipped})
    if skipped:
        mark, colour = "SKIP", YELLOW
    else:
        mark, colour = ("PASS", GREEN) if ok else ("FAIL", RED)
    print(f"  {colour}{mark}{RESET}  {name}")
    if detail and (not ok or skipped):
        for line in str(detail).strip().splitlines()[:6]:
            print(f"        {DIM}{line}{RESET}")
    return ok


def section(title: str) -> None:
    print(f"\n{BOLD}{title}{RESET}")


def sonic_port(ifname: str) -> str:
    """ethN -> Ethernet(4*(N-1)); anything else passes through (rail interfaces)."""
    m = re.fullmatch(r"eth(\d+)", ifname)
    if not m:
        return ifname
    n = int(m.group(1))
    return f"Ethernet{4 * (n - 1)}" if n >= 1 else ifname


def ping_received(out: str) -> int:
    """Replies counted from a ping summary.

    iputils says "5 received"; busybox (the FRR image) says "5 packets received". The
    fabric mixes both, so match either rather than silently reading every success as zero.
    """
    m = re.search(r"(\d+) (?:packets )?received", out)
    return int(m.group(1)) if m else 0


def leaf_gateway(name: str) -> str:
    """The leaf's rail gateway address with prefix, from whichever artifact this profile renders."""
    ddir = LAB / "out" / "artifacts" / name
    fab = ddir / "fabric.json"
    if fab.exists():
        return json.loads(fab.read_text())["bridge"]["ip"]
    cfg = json.loads((ddir / "config_db.json").read_text())
    return next((k.split("|", 1)[1] for k in cfg.get("VLAN_INTERFACE", {}) if "|" in k), "")


def lldp_neighbors(device: str) -> dict[str, list[tuple[str, str]]]:
    """Discovered neighbours per local port: {port: [(sysname, remote_port), ...]}.

    lldpcli reports one entry per (interface, neighbour) pair, keyed by interface name, so
    a port can legitimately appear several times. Entries naming this device itself are
    dropped: the virtual switch floods a frame it received back out of its own ports, so
    each switch sees an echo of its own advertisement. That is an artefact of the
    emulation, not a cabling loop.
    """
    rc, out = docker(device, "lldpcli", "-f", "json", "show", "neighbors")
    found: dict[str, list[tuple[str, str]]] = {}
    if rc != 0 or "{" not in out:
        return found
    try:
        data = json.loads(out[out.index("{"):])
    except ValueError:
        return found

    entries = data.get("lldp", {}).get("interface", [])
    if isinstance(entries, dict):
        entries = [entries]

    for entry in entries:
        for ifname, info in entry.items():
            if not isinstance(info, dict):
                continue
            chassis = info.get("chassis", {})
            sysname = next(iter(chassis), "") if isinstance(chassis, dict) else ""
            if not sysname or sysname == device:
                continue
            port = info.get("port", {})
            pid = port.get("id", {}) if isinstance(port, dict) else {}
            portid = pid.get("value", "") if isinstance(pid, dict) else str(pid)
            found.setdefault(sonic_port(ifname), []).append((str(sysname), str(portid)))
    return found


# --------------------------------------------------------------------- checks


def check_seed() -> None:
    section("1. Seed node services")
    body = http("/ztp/health")
    check("seed", "ZTP API is serving", body is not None and '"ok": true' in (body or "").replace('"ok":true', '"ok": true'),
          body or "no response", "the seed can answer a booting device")
    check("seed", "Artifact store is serving golden configs",
          http("/artifacts/manifest.json") is not None, "",
          "devices can fetch the configs the seed rendered")
    metrics = http("/metrics") or ""
    check("seed", "Provisioning state is exported to Prometheus",
          "aidc_ztp_devices_provisioned" in metrics, "",
          "bootstrap progress is observable, not guesswork")
    rc, out = docker("seed-dnsmasq", "sh", "-c", "true")
    check("seed", "DHCP/DNS/TFTP service is running", rc == 0, out,
          "the provisioning services are up")


def check_provisioning(manifest: dict) -> None:
    section("2. Zero-touch provisioning")
    inv = json.loads(http("/ztp/inventory") or "{}")
    expected = set(manifest["devices"])
    registered = set(inv.get("registered", []))

    check("ztp", f"All {len(expected)} devices completed ZTP and registered",
          registered == expected,
          f"missing: {sorted(expected - registered)}",
          "every device booted with no config and provisioned itself from the seed")

    check("ztp", "No unknown MACs requested a config",
          not inv.get("unknown_macs"),
          f"unknown: {inv.get('unknown_macs')}",
          "nothing outside the source of truth was handed a configuration")

    for name in sorted(expected):
        state = LAB / "out" / "state" / name / "ztp-complete"
        failed = LAB / "out" / "state" / name / "ztp-failed"
        detail = failed.read_text().strip() if failed.exists() else ""
        check("ztp", f"{name}: ZTP completed", state.exists(), detail)

    # The lease each device received must be the reservation the SoT defines.
    section("3. DHCP identity")
    for name, entry in sorted(manifest["devices"].items()):
        want = entry["mgmt_ip"].split("/")[0]
        rc, out = docker(name, "ip", "-4", "-o", "addr", "show", "dev", "eth0")
        got = ""
        m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", out)
        if m:
            got = m.group(1)
        check("dhcp", f"{name}: leased its reserved address {want}", got == want,
              f"got {got or 'nothing'}",
              "DHCP identity comes from the source of truth, keyed on MAC")


def check_config_integrity(manifest: dict) -> None:
    section("4. Golden config integrity")
    # Must match the ZTP API's DEST_MAP: where each rendered artifact lands on a device.
    dest = {"config_db.json": "/etc/sonic/config_db.json",   # sonic profile
            "fabric.json": "/etc/aidc/fabric.json",          # frr profile
            "frr.conf": "/etc/frr/frr.conf",
            "node.json": "/etc/aidc/node.json"}

    for name, entry in sorted(manifest["devices"].items()):
        # What the device recorded at install time, before anything rewrote the files.
        ledger: dict[str, str] = {}
        led_path = LAB / "out" / "state" / name / "installed.tsv"
        if led_path.exists():
            for line in led_path.read_text(encoding="utf-8").splitlines():
                parts = line.split("\t")
                if len(parts) >= 2:
                    ledger[parts[0]] = parts[1]

        for fname, digest in entry["files"].items():
            path = dest[fname]
            got = ledger.get(path, "")
            check("config", f"{name}: {fname} fetched from the seed intact",
                  got == digest,
                  f"seed served {digest[:12]}, device recorded {got[:12] or 'nothing'}",
                  "the device is running the exact bytes the seed rendered")

            rc, _ = docker(name, "test", "-f", path)
            check("config", f"{name}: {fname} present on disk", rc == 0,
                  f"{path} missing",
                  "the artifact survived installation and is what the NOS loaded")


def check_sonic_state(manifest: dict, switches: list[str]) -> None:
    section("5. SONiC programmed the config into the ASIC")
    for name in switches:
        # syncd is the process that owns the virtual ASIC. If it has died, every other
        # check on this device is measuring a corpse, so report it first and plainly.
        rc, out = docker(name, "supervisorctl", "status", "syncd", "orchagent")
        alive = out.count("RUNNING") == 2
        check("sonic", f"{name}: syncd and orchagent are running", alive, out.strip(),
              "the virtual ASIC is alive; sonic-vs can crash syncd on next-hop removal")
        if not alive:
            continue

        cfg = json.loads((LAB / "out" / "artifacts" / name / "config_db.json").read_text())
        want_ports = sorted(cfg["PORT"])

        rc, out = docker(name, "redis-cli", "-n", "6", "keys", "PORT_TABLE|Ethernet*")
        got_ports = sorted(x.split("|")[1] for x in out.split() if "|" in x)
        check("sonic", f"{name}: all {len(want_ports)} front-panel ports in STATE_DB",
              got_ports == want_ports, f"want {want_ports}\ngot  {got_ports}",
              "config_db.json was accepted and programmed, not merely copied")

        # Every L3 address the SoT specifies must actually be on an interface.
        wanted_addrs = []
        for table in ("INTERFACE", "LOOPBACK_INTERFACE", "VLAN_INTERFACE"):
            for key in cfg.get(table, {}):
                if "|" in key:
                    wanted_addrs.append(key.split("|", 1)[1])
        rc, out = docker(name, "ip", "-4", "-o", "addr", "show")
        present = set(re.findall(r"inet (\d+\.\d+\.\d+\.\d+/\d+)", out))
        missing = [a for a in wanted_addrs if a not in present]
        check("sonic", f"{name}: {len(wanted_addrs)} L3 addresses programmed",
              not missing, f"missing {missing}",
              "loopbacks, point-to-point links and rail gateways are live")

        rc, out = docker(name, "redis-cli", "-n", "4", "hget", "PORT|Ethernet0", "mtu")
        check("sonic", f"{name}: jumbo MTU applied to front-panel ports",
              out.strip() == "9216", f"MTU is {out.strip()}",
              "a rail silently running 1500 fragments every RDMA transfer")


def check_frr_state(manifest: dict, switches: list[str]) -> None:
    section("5. FRR switches programmed the config into the Linux data plane")
    for name in switches:
        cfg = json.loads((LAB / "out" / "artifacts" / name / "fabric.json").read_text())

        rc, out = docker(name, "ip", "-br", "link", "show")
        present = {ln.split()[0].split("@")[0] for ln in out.splitlines() if ln.strip()}
        want_ports = [p["name"] for p in cfg["ports"]]
        missing = [p for p in want_ports if p not in present]
        check("frr", f"{name}: all {len(want_ports)} front-panel ports named per the plan",
              not missing, f"missing {missing}",
              "interfaces carry the cable plan's port names, assigned by the seed")

        rc, out = docker(name, "ip", "-4", "-o", "addr", "show")
        addrs = set(re.findall(r"inet (\d+\.\d+\.\d+\.\d+/\d+)", out))
        wanted = [p["ip"] for p in cfg["ports"] if p["mode"] == "routed"]
        if cfg.get("loopback"):
            wanted.append(cfg["loopback"])
        if cfg.get("bridge"):
            wanted.append(cfg["bridge"]["ip"])
        missing = [a for a in wanted if a not in addrs]
        check("frr", f"{name}: {len(wanted)} L3 addresses programmed", not missing,
              f"missing {missing}", "underlay, loopback and rail gateway are live")

        if cfg.get("bridge"):
            br = cfg["bridge"]["name"]
            members = [p["name"] for p in cfg["ports"] if p["mode"] == "access"]
            rc, out = docker(name, "ip", "-br", "link", "show", "master", br)
            enslaved = {ln.split()[0].split("@")[0] for ln in out.splitlines() if ln.strip()}
            missing = [m for m in members if m not in enslaved]
            check("frr", f"{name}: rail bridge {br} has all {len(members)} host ports",
                  not missing, f"missing {missing}\n{out.strip()}",
                  "the rail is one L2 domain, so same-rail traffic is a single hop")

        rc, out = docker(name, "cat", "/sys/class/net/" + want_ports[0] + "/mtu")
        check("frr", f"{name}: jumbo MTU applied to front-panel ports",
              out.strip() == "9216", f"MTU is {out.strip()}",
              "a link that silently came up at 1500 fragments every large transfer")

        rc, out = docker(name, "sh", "-c", "sysctl -n net.ipv4.ip_forward")
        check("frr", f"{name}: IP forwarding enabled", out.strip() == "1",
              f"ip_forward={out.strip()!r}", "the switch will actually forward transit traffic")


def check_frr_drift(switches: list[str]) -> None:
    section("11. Configuration drift")
    for name in switches:
        cfg = json.loads((LAB / "out" / "artifacts" / name / "fabric.json").read_text())
        drift = []
        for port in cfg["ports"]:
            rc, out = docker(name, "cat", f"/sys/class/net/{port['name']}/mtu")
            if out.strip() != str(port["mtu"]):
                drift.append(f"{port['name']}.mtu intended {port['mtu']} running {out.strip()!r}")
            if port["mode"] == "routed":
                rc, out = docker(name, "ip", "-4", "-o", "addr", "show", "dev", port["name"])
                if port["ip"] not in out:
                    drift.append(f"{port['name']} intended {port['ip']}, not present")
        rc, out = docker(name, "vtysh", "-c", "show bgp summary json")
        try:
            asn = json.loads(out[out.index("{"):]).get("ipv4Unicast", {}).get("as")
        except ValueError:
            asn = None
        if asn != cfg["asn"]:
            drift.append(f"bgp asn intended {cfg['asn']} running {asn}")

        check("drift", f"{name}: running config matches intent", not drift,
              "\n".join(drift), "the fabric is still a rendering of the source of truth")


def check_qos(switches: list[str]) -> None:
    section("6. Lossless QoS is consistent fabric-wide")
    signatures = {}
    for name in switches:
        rc, pfc = docker(name, "redis-cli", "-n", "4", "hget", "PORT_QOS_MAP|Ethernet0",
                         "pfc_enable")
        rc2, wred = docker(name, "redis-cli", "-n", "4", "hgetall",
                           "WRED_PROFILE|AZURE_LOSSLESS")
        rc3, wd = docker(name, "redis-cli", "-n", "4", "hget", "PFC_WD|Ethernet0", "action")
        signatures[name] = (pfc.strip(), " ".join(sorted(wred.split())), wd.strip())
        check("qos", f"{name}: PFC enabled on the lossless priority",
              pfc.strip() == "3", f"pfc_enable={pfc.strip()!r}",
              "RoCE traffic class is paused, everything else is not")
        check("qos", f"{name}: ECN/WRED profile programmed",
              "green_min_threshold" in wred, wred[:120],
              "congestion is marked early instead of paused late")
        check("qos", f"{name}: PFC watchdog armed", wd.strip() == "drop", f"action={wd.strip()!r}",
              "a stuck pause storm gets broken instead of spreading")

    uniq = set(signatures.values())
    check("qos", "QoS policy is byte-identical on every switch", len(uniq) == 1,
          "\n".join(f"{k}: {v}" for k, v in signatures.items()),
          "the one-off mismatch that creates silent stragglers cannot exist here")


def check_bgp(manifest: dict, switches: list[str]) -> None:
    section("7. BGP underlay")
    expected_peers = {}
    for name in switches:
        n = sum(1 for p in manifest["devices"][name]["expected_lldp"].values()
                if p["type"] == "fabric")
        expected_peers[name] = n

    for name in switches:
        rc, out = docker(name, "vtysh", "-c", "show bgp ipv4 unicast summary json")
        est = total = -1
        try:
            data = json.loads(out[out.index("{"):])
            peers = data.get("ipv4Unicast", data).get("peers", {})
            total = len(peers)
            est = sum(1 for v in peers.values() if v.get("state") == "Established")
        except (ValueError, KeyError):
            pass
        check("bgp", f"{name}: {expected_peers[name]} BGP sessions established",
              est == expected_peers[name] and total == expected_peers[name],
              f"established {est}/{total}, expected {expected_peers[name]}\n{out[:200]}",
              "the underlay came up from seed-rendered config with no manual step")

    # A leaf must learn every other rail's prefix, over both spines.
    section("8. Route propagation and ECMP")
    leaves = [s for s in switches if s.startswith("leaf")]

    # Each leaf owns exactly one rail prefix (it is directly connected, so it is never
    # learned via BGP); every other rail must arrive over the fabric.
    own_rail: dict[str, str] = {}
    all_rails: set[str] = set()
    for name in leaves:
        svi = leaf_gateway(name)
        # "10.20.0.1/24" -> "10.20.0.0/24"
        net = ".".join(svi.split("/")[0].split(".")[:3]) + ".0/" + svi.split("/")[1]
        own_rail[name] = net
        all_rails.add(net)

    for name in leaves:
        rc, out = docker(name, "vtysh", "-c", "show ip route json")
        try:
            routes = json.loads(out[out.index("{"):])
        except ValueError:
            routes = {}

        remote_rails = sorted(all_rails - {own_rail[name]})
        missing = [r for r in remote_rails if r not in routes]
        check("bgp", f"{name}: learned all {len(remote_rails)} remote rail prefixes",
              not missing, f"missing {missing}",
              "every rail is reachable from every leaf with no static routes anywhere")

        multipath, single = [], []
        for r in remote_rails:
            entry = routes.get(r) or [{}]
            nhs = [n for n in entry[0].get("nexthops", []) if n.get("ip")]
            (multipath if len(nhs) >= 2 else single).append(r)
        check("bgp",
              f"{name}: ECMP over both spines ({len(multipath)}/{len(remote_rails)} prefixes)",
              not single, f"single-path: {single}",
              "a Clos fabric that does not load-balance is an expensive single path")


def check_cabling(manifest: dict) -> None:
    section("9. Cabling validated against the source of truth")
    total_ok = total = 0
    for name, entry in sorted(manifest["devices"].items()):
        expected = entry["expected_lldp"]
        discovered = lldp_neighbors(name)

        mismatches = []
        for port, want in expected.items():
            got = set(discovered.get(port, []))
            total += 1
            wanted = (want["neighbor"], want["neighbor_port"])
            if not got:
                mismatches.append(
                    f"{port}: no LLDP neighbour (expected {want['neighbor']} {want['neighbor_port']})")
            elif got == {wanted}:
                total_ok += 1
            else:
                # Exact match, not merely "the expected neighbour is among those seen".
                # Every cable here is point to point, so a second neighbour on a port is
                # an anomaly in its own right -- and it is what a freshly re-patched cable
                # looks like while the previous advertisement is still inside its TTL.
                found = ", ".join(f"{s} {p}" for s, p in sorted(got))
                mismatches.append(
                    f"{port}: MIS-CABLED -- expected {want['neighbor']} {want['neighbor_port']}, "
                    f"found {found}"
                )

        check("cabling", f"{name}: {len(expected)} cables match the plan", not mismatches,
              "\n".join(mismatches),
              "NIC k really is on rail k -- the constraint a mis-cable silently violates")

    print(f"  {DIM}{total_ok}/{total} cable endpoints verified against the cable plan{RESET}")


def check_dataplane(quick: bool, profile: str = "sonic") -> None:
    section("10. Reachability")
    if quick:
        check("dataplane", "reachability probes", True, "", "", skipped=True)
        return

    # Control-plane reachability: these terminate on a switch CPU and are what sonic-vs
    # actually implements.
    for src, dst, what in [
        ("leaf1", "10.1.1.1", "leaf1 -> spine1 over the point-to-point underlay"),
        ("leaf1", "10.0.0.1", "leaf1 -> spine1 loopback"),
        ("leaf2", "10.0.0.2", "leaf2 -> spine2 loopback"),
        ("gpu01", "10.20.0.1", "gpu01 -> its rail gateway on leaf1"),
    ]:
        # Five probes, and success means at least one reply. The first is routinely lost to
        # ARP resolution, and the emulated ASIC is not a performance model -- what is being
        # proven here is that seed-rendered addressing produces a reachable fabric, not a
        # loss rate.
        rc, out = docker(src, "ping", "-c", "5", "-W", "2", dst, timeout=25)
        received = ping_received(out)
        loss = "?"
        m = re.search(r"([\d.]+)% packet loss", out)
        if m:
            loss = m.group(1)
        check("dataplane", what, received > 0,
              f"{received}/5 replies ({loss}% loss)\n" + out.strip()[-200:],
              "seed-rendered addressing produces a fabric that actually passes traffic")

    # Host-to-host forwarding is not something sonic-vs can do; say so rather than
    # reporting a failure the lab cannot fix.
    if profile != "frr":
        check("dataplane",
              "host-to-host forwarding through the ASIC",
              True,
              "sonic-vs implements the SAI control plane only -- libsaivs keeps ASIC_DB state "
              "but has no packet-forwarding pipeline, so transit and bridged traffic between "
              "front-panel ports is never forwarded. Routes stay in zebra's 'q' (queued) state "
              "for the same reason. Run the lab with -Frr to prove forwarding. "
              "See README 'What this lab does and does not prove'.",
              "", skipped=True)


def check_forwarding(quick: bool) -> None:
    """Real host-to-host forwarding. Only meaningful on the FRR profile.

    This is the section the SONiC profile cannot run: traffic that has to be bridged or
    routed between front-panel ports, measured rather than asserted.
    """
    section("10b. Data plane -- host to host")
    if quick:
        check("forwarding", "forwarding probes", True, "", "", skipped=True)
        return

    # --- same rail: one switched hop through the leaf's rail bridge -------------
    rc, out = docker("gpu01", "ping", "-c", "5", "-W", "2", "10.20.0.12", timeout=25)
    recv = ping_received(out)
    check("forwarding", "same-rail: gpu01 -> gpu02 on rail0 (switched by leaf1)",
          recv >= 4, f"{recv}/5 replies\n{out.strip()[-160:]}",
          "NIC 0 to NIC 0 stays inside one rail -- the traffic pattern the design optimises")

    # --- every rail is usable, and each stays one hop ---------------------------
    # In a rail-optimised pod every node sits on every rail, so node-to-node traffic is
    # always same-rail and always one switched hop. That is the whole point of the design:
    # NCCL keeps GPU k talking to GPU k, and no collective needs a spine. Traffic that
    # genuinely must cross rails is moved over NVLink inside the box instead (NCCL's PXN),
    # which is why the fabric is built this way.
    for rail, dst in [(1, "10.21.0.12"), (2, "10.22.0.12"), (3, "10.23.0.12")]:
        rc, out = docker("gpu01", "ping", "-c", "3", "-W", "2", dst, timeout=25)
        recv = ping_received(out)
        check("forwarding", f"rail{rail}: gpu01 -> gpu02 (switched by leaf{rail + 1})",
              recv >= 2, f"{recv}/3 replies\n{out.strip()[-160:]}",
              "every rail carries traffic, so no NIC is stranded")

    rc, out = docker("gpu01", "traceroute", "-n", "-w", "1", "-q", "1", "-m", "4",
                     "10.20.0.12", timeout=30)
    hops = [ln for ln in out.splitlines() if re.match(r"\s*\d+\s+\d", ln)]
    check("forwarding", f"same-rail path is 1 hop (never touches a spine), saw {len(hops)}",
          len(hops) == 1, out.strip()[-200:],
          "same-rail traffic crosses one leaf -- the latency the rail design buys")

    # --- transit: traffic that genuinely has to cross the fabric -----------------
    # A leaf's loopback exists only behind the fabric, so reaching it from a compute node
    # forces leaf -> spine -> leaf and proves the spines really forward transit traffic.
    rc, out = docker("gpu01", "ping", "-c", "5", "-W", "2", "10.0.1.2", timeout=25)
    recv = ping_received(out)
    check("forwarding", "transit: gpu01 -> leaf2 loopback (leaf -> spine -> leaf)",
          recv >= 4, f"{recv}/5 replies\n{out.strip()[-160:]}",
          "the spines forward transit traffic; the Clos is a working fabric, not two islands")

    rc, out = docker("gpu01", "traceroute", "-n", "-w", "1", "-q", "1", "-m", "6",
                     "10.0.1.2", timeout=40)
    hops = [ln for ln in out.splitlines() if re.match(r"\s*\d+\s+\d", ln)]
    check("forwarding", f"transit path is 3 hops (gateway, spine, target), saw {len(hops)}",
          len(hops) == 3, out.strip()[-300:],
          "the path is the one the topology intends, not an accidental shortcut")

    rc, out = docker("gpu01", "ping", "-c", "3", "-W", "2", "-M", "do", "-s", "8972",
                     "10.0.1.2", timeout=25)
    check("forwarding", "jumbo frames survive the transit path (9000B unfragmented)",
          ping_received(out) >= 2, out.strip()[-200:],
          "MTU holds across a spine, not just on a directly connected rail")

    # --- jumbo frames end to end --------------------------------------------------
    # 8972 = 9000 - 28 (IP+ICMP). Sent with DF, so anything that quietly fragments fails.
    for dst, what in [("10.20.0.12", "rail0"), ("10.21.0.12", "rail1")]:
        rc, out = docker("gpu01", "ping", "-c", "3", "-W", "2", "-M", "do", "-s", "8972",
                         dst, timeout=25)
        recv = ping_received(out)
        check("forwarding", f"jumbo frames survive end to end ({what}, 9000B unfragmented)",
              recv >= 2, f"{recv}/3 replies\n{out.strip()[-200:]}",
              "a rail that silently fell back to 1500 would fragment every RDMA transfer")

    # --- ECMP actually spreads flows across both spines ---------------------------
    rc, out = docker("leaf1", "ip", "route", "show", "10.21.0.0/24")
    nexthops = len(re.findall(r"nexthop\s+via", out)) or (1 if "via" in out else 0)
    check("forwarding", f"leaf1 installs {nexthops} kernel next-hops for a remote rail",
          nexthops >= 2, out.strip(),
          "ECMP is programmed into the forwarding table, not just chosen in BGP")

    # Different L4 tuples must be able to pick different uplinks. With the default hash
    # policy every flow between the same pair of hosts lands on one spine.
    rc, out = docker("leaf1", "sh", "-c", "sysctl -n net.ipv4.fib_multipath_hash_policy")
    check("forwarding", "L4 multipath hashing is enabled on the leaves",
          out.strip() == "1", f"fib_multipath_hash_policy={out.strip()!r}",
          "3-tuple hashing collapses AI traffic's few elephant flows onto one uplink")

    # --- throughput: measured, not asserted ---------------------------------------
    for dst, what, label in [("10.20.0.12", "rail0", "gpu02"),
                             ("10.21.0.12", "rail1", "gpu02")]:
        rc, out = docker("gpu01", "iperf3", "-c", dst, "-t", "3", "-J", timeout=40)
        gbps = None
        try:
            data = json.loads(out[out.index("{"):])
            gbps = data["end"]["sum_received"]["bits_per_second"] / 1e9
        except (ValueError, KeyError):
            pass
        check("forwarding", f"throughput {what} to {label}: "
                            f"{f'{gbps:.1f} Gbit/s' if gbps else 'no result'}",
              gbps is not None and gbps > 0.1,
              out.strip()[-200:],
              "real bytes move between compute nodes across the provisioned fabric")


def check_drift(switches: list[str]) -> None:
    section("11. Configuration drift")
    for name in switches:
        cfg = json.loads((LAB / "out" / "artifacts" / name / "config_db.json").read_text())
        drift = []
        for port, attrs in cfg["PORT"].items():
            rc, out = docker(name, "redis-cli", "-n", "4", "hget", f"PORT|{port}", "mtu")
            if out.strip() != attrs["mtu"]:
                drift.append(f"{port}.mtu intended {attrs['mtu']} running {out.strip()!r}")
        rc, out = docker(name, "redis-cli", "-n", "4", "hget",
                         "DEVICE_METADATA|localhost", "bgp_asn")
        want_asn = cfg["DEVICE_METADATA"]["localhost"]["bgp_asn"]
        if out.strip() != want_asn:
            drift.append(f"bgp_asn intended {want_asn} running {out.strip()!r}")

        check("drift", f"{name}: running config matches intent", not drift,
              "\n".join(drift),
              "the fabric is still a rendering of the source of truth")


# ----------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="skip reachability probes")
    ap.add_argument("--json", help="write the full report to this path")
    args = ap.parse_args()

    if not MANIFEST.exists():
        sys.exit(f"no manifest at {MANIFEST} -- run the render step first")
    manifest = json.loads(MANIFEST.read_text())
    switches = sorted(n for n, e in manifest["devices"].items()
                      if e["role"] in ("spine", "leaf"))
    profile = manifest.get("profile", "sonic")

    print(f"{BOLD}AI datacenter seed -- end-to-end verification{RESET}")
    print(f"{DIM}{len(manifest['devices'])} devices from {MANIFEST}{RESET}")
    print(f"{DIM}switch profile: {profile}{RESET}")

    # Everything up to here is identical across profiles: the same seed provisions the
    # same devices from the same source of truth. Only what runs on the switches differs.
    check_seed()
    check_provisioning(manifest)
    check_config_integrity(manifest)

    if profile == "frr":
        check_frr_state(manifest, switches)
        section("6. Lossless QoS")
        check("qos", "PFC / ECN / buffer policy",
              True,
              "PFC, ECN marking and buffer profiles are ASIC features with no equivalent in "
              "the Linux data plane. The sonic profile verifies this fabric's QoS intent is "
              "rendered and programmed consistently on every switch; this profile trades "
              "that for real packet forwarding.",
              "", skipped=True)
    else:
        check_sonic_state(manifest, switches)
        check_qos(switches)

    check_bgp(manifest, switches)
    check_cabling(manifest)
    check_dataplane(args.quick, profile)

    if profile == "frr":
        check_forwarding(args.quick)
        check_frr_drift(switches)
    else:
        check_drift(switches)

    passed = sum(1 for r in results if r["ok"] and not r["skipped"])
    failed = [r for r in results if not r["ok"] and not r["skipped"]]
    skipped = sum(1 for r in results if r["skipped"])

    print(f"\n{BOLD}{'=' * 62}{RESET}")
    print(f"{BOLD}Result: {GREEN}{passed} passed{RESET}, "
          f"{RED if failed else DIM}{len(failed)} failed{RESET}, "
          f"{YELLOW if skipped else DIM}{skipped} skipped{RESET}")
    if failed:
        print(f"\n{RED}Failures:{RESET}")
        for r in failed:
            print(f"  - [{r['section']}] {r['name']}")

    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(f"{DIM}report written to {args.json}{RESET}")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
