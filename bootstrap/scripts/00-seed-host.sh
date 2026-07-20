#!/usr/bin/env bash
# Phase 0: configure seed01 as DHCP/DNS/NTP/iPXE/image host for BOOT rack.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INV="${ROOT}/inventory/cluster.yaml"
SEED_DIR="${ROOT}/seed"
OUT="${SEED_DIR}/generated"
mkdir -p "${OUT}/autoinstall" "${OUT}/matchbox" /var/www/html/images 2>/dev/null || true

# Prefer NetBox-exported inventory
if [[ "${SKIP_NETBOX_SYNC:-0}" != "1" ]]; then
  if [[ -n "${NETBOX_TOKEN:-}" ]] || [[ ! -f "${INV}" ]]; then
    bash "${ROOT}/scripts/netbox-sync.sh" || bash "${ROOT}/scripts/netbox-sync.sh" --offline || true
  fi
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1"; exit 1; }; }
need yq
need envsubst

if [[ ! -f "${INV}" ]]; then
  echo "No inventory at ${INV}. Run: bash scripts/netbox-sync.sh --offline" >&2
  exit 1
fi
if head -1 "${INV}" | grep -qv GENERATED && grep -q 'source_of_truth' "${INV}" 2>/dev/null; then
  :
fi
if ! grep -q 'source_of_truth' "${INV}" 2>/dev/null; then
  echo "WARN: ${INV} was not exported from NetBox (missing source_of_truth). Prefer netbox-sync.sh" >&2
fi

DOMAIN="$(yq -r '.network.mgmt.dns[0] as $d | .cluster.domain' "${INV}")"
SEED_IP="$(yq -r '.seed.ip' "${INV}")"
GATEWAY="$(yq -r '.network.mgmt.gateway' "${INV}")"
CP_VIP="$(yq -r '.control_plane.vip' "${INV}")"
HARBOR_IP="$(yq -r '.utility.nodes[0].ip' "${INV}")"
VAULT_IP="$(yq -r '.utility.nodes[1].ip // .utility.nodes[0].ip' "${INV}")"

echo "==> Installing packages (Ubuntu)"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq dnsmasq chrony nginx jq curl pxelinux syslinux-common ipxe || true

echo "==> Rendering dnsmasq"
STATIC_LEASES=""
HOST_RECORDS=""
while IFS= read -r line; do
  name="$(echo "$line" | yq -r '.name')"
  ip="$(echo "$line" | yq -r '.ip')"
  mac="$(echo "$line" | yq -r '.mac_mgmt')"
  STATIC_LEASES+="dhcp-host=${mac},${ip},${name},infinite"$'\n'
  HOST_RECORDS+="address=/${name}.${DOMAIN}/${ip}"$'\n'
done < <(yq -o=json -I=0 '.control_plane.nodes + .utility.nodes + .gpu_workers.nodes' "${INV}" | jq -c '.[]')

export domain="${DOMAIN}" seed_ip="${SEED_IP}" gateway="${GATEWAY}"
export dhcp_start="10.10.0.200" dhcp_end="10.10.0.250"
export cp_vip="${CP_VIP}" harbor_ip="${HARBOR_IP}" vault_ip="${VAULT_IP}"

# shellcheck disable=SC2016
envsubst '${domain} ${seed_ip} ${gateway} ${dhcp_start} ${dhcp_end} ${cp_vip} ${harbor_ip} ${vault_ip}' \
  < "${SEED_DIR}/dnsmasq.conf.tmpl" > "${OUT}/dnsmasq.conf"
{
  cat "${OUT}/dnsmasq.conf"
  echo
  echo "# static leases"
  printf '%s' "${STATIC_LEASES}"
  echo "# host records"
  printf '%s' "${HOST_RECORDS}"
} | sudo tee /etc/dnsmasq.d/ai-cluster.conf >/dev/null
sudo cp "${SEED_DIR}/chrony.conf" /etc/chrony/chrony.conf

sed "s/{{ seed_ip }}/${SEED_IP}/g; s/{{ domain }}/${DOMAIN}/g" \
  "${SEED_DIR}/matchbox/boot.ipxe" > "${OUT}/matchbox/boot.ipxe"
sudo mkdir -p /var/www/html
sudo cp "${OUT}/matchbox/boot.ipxe" /var/www/html/boot.ipxe

echo "==> Rendering Arista ZTP payload"
if [[ -f "${SEED_DIR}/ztp/render.py" ]]; then
  python3 "${SEED_DIR}/ztp/render.py" -o "${OUT}/ztp"
  sudo mkdir -p /var/www/html/ztp
  sudo cp "${SEED_DIR}/ztp/ztp.py" /var/www/html/ztp/ztp.py
  sudo cp -r "${OUT}/ztp/." /var/www/html/ztp/
  echo "    ZTP: $(ls "${OUT}/ztp/configs" | wc -l) switch configs → http://${SEED_IP}/ztp/"
fi

echo "==> Enabling services"
sudo systemctl enable --now chrony
sudo systemctl restart dnsmasq
sudo systemctl enable --now dnsmasq
sudo systemctl enable --now nginx

# Merge NetBox dhcp-host exports when present
if [[ -f "${OUT}/dhcp-hosts.conf" ]]; then
  sudo cp "${OUT}/dhcp-hosts.conf" /etc/dnsmasq.d/ai-cluster-hosts.conf
  sudo systemctl restart dnsmasq
fi

cat <<EOF
Seed host ready.

  DNS/DHCP/NTP : ${SEED_IP}
  Domain       : ${DOMAIN}
  iPXE boot    : http://${SEED_IP}/boot.ipxe
  Images dir   : /var/www/html/images  (place Ubuntu cloudimg + IPA here)

Next:
  1. Fill real MAC/BMC in inventory/cluster.yaml
  2. Export BMC_USERNAME BMC_PASSWORD
  3. Create a management/seed kube (k3s or kind) OR use scripts/01 once CP utility exists
  4. bash scripts/01-install-capi-metal3.sh
EOF
