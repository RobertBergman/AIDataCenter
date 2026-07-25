#!/usr/bin/env python3
"""Deliberately mis-cable a rail, to prove the cabling check actually catches it.

A validation check that has never failed is not a validation check. This swaps two GPU
node rail connections so that NIC 2 lands on the rail-3 leaf and vice versa -- the exact
mistake that costs real money: the fabric stays up, every link is green, BGP is happy, and
the affected node's collectives quietly route the long way round forever.

    python scripts/inject-miscable.py            # break it
    python scripts/inject-miscable.py --repair   # put it back

After injecting, run `python scripts/verify.py` and watch section 9 fail.
"""

from __future__ import annotations

import argparse
import subprocess
import sys

NODE = "gpu01"
# gpu01's rail2 cable goes to leaf3, rail3 goes to leaf4. Swapping the two interface names
# inside the node is indistinguishable, from the network's point of view, from a technician
# swapping two transceivers in the rack.
SWAP = ("rail2", "rail3")


def sh(*cmd: str) -> tuple[int, str]:
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def swap_interfaces() -> int:
    a, b = SWAP
    steps = [
        ("ip", "link", "set", "dev", a, "down"),
        ("ip", "link", "set", "dev", a, "name", "railtmp"),
        ("ip", "link", "set", "dev", b, "down"),
        ("ip", "link", "set", "dev", b, "name", a),
        ("ip", "link", "set", "dev", "railtmp", "name", b),
        ("ip", "link", "set", "dev", a, "up"),
        ("ip", "link", "set", "dev", b, "up"),
    ]
    for step in steps:
        rc, out = sh("docker", "exec", NODE, *step)
        if rc != 0:
            print(f"failed: {' '.join(step)}\n{out}", file=sys.stderr)
            return rc

    # LLDP must re-advertise under the swapped names, otherwise the neighbours keep
    # reporting the old, correct-looking topology from cache.
    sh("docker", "exec", NODE, "sh", "-c",
       "lldpcli configure ports rail2 lldp portidsubtype local rail2; "
       "lldpcli configure ports rail3 lldp portidsubtype local rail3; "
       "lldpcli update")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repair", action="store_true", help="undo the swap")
    args = ap.parse_args()

    rc, _ = sh("docker", "inspect", NODE)
    if rc != 0:
        sys.exit(f"{NODE} is not running -- start the lab first")

    if swap_interfaces() != 0:
        return 1

    a, b = SWAP
    if args.repair:
        print(f"repaired: {NODE} {a}/{b} are back on their intended rails")
        print("run scripts/verify.py -- section 9 should pass again")
    else:
        print(f"MIS-CABLED: {NODE} {a} and {b} are now crossed")
        print(f"  {a} is physically on the rail-3 leaf, {b} on the rail-2 leaf")
        print("\nNothing is 'down'. BGP stays up, every interface stays green.")
        print("run scripts/verify.py -- section 9 should now fail on gpu01, leaf3 and leaf4")
    print("\nLLDP needs ~30s to re-converge before the check reflects the change.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
