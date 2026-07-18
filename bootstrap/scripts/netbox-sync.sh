#!/usr/bin/env bash
# Refresh generated inventory / IPAM / cabling / dnsmasq from NetBox SoT.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NB="${ROOT}/netbox"
export PYTHONPATH="${NB}/scripts${PYTHONPATH:+:$PYTHONPATH}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1"; exit 1; }; }
need python3

OFFLINE=0
if [[ "${1:-}" == "--offline" ]] || [[ -z "${NETBOX_TOKEN:-}" && -z "${NETBOX_URL:-}" ]]; then
  OFFLINE=1
fi

cd "${NB}"
python3 -c "import yaml" 2>/dev/null || pip3 install -q -r requirements.txt

if [[ "${OFFLINE}" -eq 1 ]]; then
  echo "==> Offline mode (seed/site.yaml)"
  python3 scripts/export_inventory.py --offline -o "${ROOT}/inventory/cluster.yaml"
  python3 scripts/export_ipam.py --offline -o "${ROOT}/inventory/ipam.yaml"
  python3 scripts/export_cabling.py --offline \
    -o "${ROOT}/../docs/cabling.md" \
    --csv "${ROOT}/../docs/cabling.csv"
  python3 scripts/export_dnsmasq.py --offline -o "${ROOT}/seed/generated/dhcp-hosts.conf"
else
  echo "==> NetBox ${NETBOX_URL:-http://127.0.0.1:8081}"
  python3 scripts/export_inventory.py -o "${ROOT}/inventory/cluster.yaml"
  python3 scripts/export_ipam.py -o "${ROOT}/inventory/ipam.yaml"
  python3 scripts/export_cabling.py \
    -o "${ROOT}/../docs/cabling.md" \
    --csv "${ROOT}/../docs/cabling.csv"
  python3 scripts/export_dnsmasq.py -o "${ROOT}/seed/generated/dhcp-hosts.conf"
fi

echo "Synced:"
echo "  ${ROOT}/inventory/cluster.yaml"
echo "  ${ROOT}/inventory/ipam.yaml"
echo "  docs/cabling.md + docs/cabling.csv"
echo "  ${ROOT}/seed/generated/dhcp-hosts.conf"
