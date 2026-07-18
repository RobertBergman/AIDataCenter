#!/usr/bin/env bash
# Render BareMetalHosts from inventory and apply CAPI cluster stack.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INV="${ROOT}/inventory/cluster.yaml"
OUT="${ROOT}/capi/generated"
mkdir -p "${OUT}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1"; exit 1; }; }
need yq
need jq
need kubectl

if [[ "${SKIP_NETBOX_SYNC:-0}" != "1" ]]; then
  bash "${ROOT}/scripts/netbox-sync.sh" 2>/dev/null || bash "${ROOT}/scripts/netbox-sync.sh" --offline
fi
if [[ ! -f "${INV}" ]]; then
  echo "inventory missing; NetBox export failed" >&2
  exit 1
fi

BMC_USER="${BMC_USERNAME:?set BMC_USERNAME}"
BMC_PASS="${BMC_PASSWORD:?set BMC_PASSWORD}"

echo "==> Rendering BareMetalHosts + BMC secrets (from NetBox inventory)"
: > "${OUT}/baremetalhosts.yaml"

render_host() {
  local name="$1" ip="$2" bmc="$3" mac="$4" rack="$5" role="$6"
  local secret="bmc-${name}"
  cat >> "${OUT}/baremetalhosts.yaml" <<EOF
---
apiVersion: v1
kind: Secret
metadata:
  name: ${secret}
  namespace: metal3
  labels:
    cluster.x-k8s.io/cluster-name: ai-cluster
type: Opaque
stringData:
  username: ${BMC_USER}
  password: ${BMC_PASS}
---
apiVersion: metal3.io/v1alpha1
kind: BareMetalHost
metadata:
  name: ${name}
  namespace: metal3
  labels:
    cluster.x-k8s.io/cluster-name: ai-cluster
    role: ${role}
    topology.kubernetes.io/rack: ${rack}
spec:
  online: true
  bmc:
    address: redfish-virtualmedia://${bmc}/redfish/v1/Systems/1
    credentialsName: ${secret}
    disableCertificateVerification: true
  bootMACAddress: "${mac}"
  bootMode: UEFI
  rootDeviceHints:
    deviceName: /dev/nvme0n1
  automatedCleaningMode: metadata
EOF
}

while IFS= read -r row; do
  render_host \
    "$(echo "$row" | jq -r .name)" \
    "$(echo "$row" | jq -r .ip)" \
    "$(echo "$row" | jq -r .bmc)" \
    "$(echo "$row" | jq -r .mac_mgmt)" \
    "$(echo "$row" | jq -r .rack)" \
    "control-plane"
done < <(yq -o=json -I=0 '.control_plane.nodes' "${INV}" | jq -c '.[]')

while IFS= read -r row; do
  render_host \
    "$(echo "$row" | jq -r .name)" \
    "$(echo "$row" | jq -r .ip)" \
    "$(echo "$row" | jq -r .bmc)" \
    "$(echo "$row" | jq -r .mac_mgmt)" \
    "$(echo "$row" | jq -r .rack)" \
    "gpu-worker"
done < <(yq -o=json -I=0 '.gpu_workers.nodes' "${INV}" | jq -c '.[]')

echo "==> Applying IP pool + cluster"
kubectl apply -k "${ROOT}/capi"
kubectl apply -f "${OUT}/baremetalhosts.yaml"

echo "==> Status"
kubectl -n metal3 get bmh,cluster,kubeadmcontrolplane,md 2>/dev/null || \
  kubectl -n metal3 get bmh,cluster

echo "Wait for control plane: clusterctl describe cluster ai-cluster -n metal3"
echo "When Ready, fetch kubeconfig: clusterctl get kubeconfig ai-cluster -n metal3 > kubeconfig-ai-cluster"
echo "Next: KUBECONFIG=kubeconfig-ai-cluster bash scripts/03-install-flux.sh"
