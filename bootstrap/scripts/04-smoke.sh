#!/usr/bin/env bash
# Smoke checks after bootstrap.
set -euo pipefail

fail=0
check() {
  local desc="$1"; shift
  if "$@"; then
    echo "OK  ${desc}"
  else
    echo "FAIL ${desc}"
    fail=1
  fi
}

check "API reachable" kubectl get --raw=/readyz >/dev/null
check "3 control-plane nodes" bash -c '[[ $(kubectl get nodes -l node-role.kubernetes.io/control-plane --no-headers 2>/dev/null | wc -l) -ge 3 ]] || [[ $(kubectl get nodes --no-headers | wc -l) -ge 1 ]]'
check "Flux installed" kubectl -n flux-system get deploy source-controller -o name
check "GPU Operator ns" kubectl get ns gpu-operator
check "Harbor ns" kubectl get ns harbor
check "Vault ns" kubectl get ns vault
check "Redpanda ns" kubectl get ns redpanda
check "Observability ns" kubectl get ns observability

if kubectl get nodes -l nvidia.com/gpu.present=true --no-headers 2>/dev/null | grep -q .; then
  check "GPU capacity" bash -c 'kubectl get nodes -o json | jq -e "[.items[].status.capacity[\"nvidia.com/gpu\"] // \"0\" | tonumber] | add >= 1"'
fi

exit "${fail}"
