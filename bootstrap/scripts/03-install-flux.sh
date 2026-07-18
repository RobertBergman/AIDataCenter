#!/usr/bin/env bash
# Phase 2: install Flux on the workload cluster and point it at this repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1"; exit 1; }; }
need kubectl
need flux

GIT_URL="${GIT_URL:-https://github.com/EXAMPLE/super.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"

echo "==> Checking cluster access"
kubectl cluster-info >/dev/null

echo "==> Installing Flux"
flux check --pre
flux install

echo "==> Applying bootstrap GitRepository path (flux-root)"
# Update Git URL in sources if provided
SOURCES="${ROOT}/platform/flux-root/sources.yaml"
if [[ "${GIT_URL}" != "https://github.com/EXAMPLE/super.git" ]]; then
  tmp="$(mktemp)"
  sed "s|https://github.com/EXAMPLE/super.git|${GIT_URL}|g" "${SOURCES}" > "${tmp}"
  kubectl apply -f "${tmp}"
  rm -f "${tmp}"
else
  kubectl apply -f "${SOURCES}"
fi

kubectl apply -f "${ROOT}/platform/flux-root/namespaces.yaml"
kubectl apply -f "${ROOT}/platform/flux-root/kustomizations.yaml"

echo "==> Flux Kustomizations"
flux get kustomizations -A || kubectl -n flux-system get kustomizations

cat <<EOF

Flux is watching ${GIT_URL} (branch ${GIT_BRANCH}).

Order of reconcile:
  platform-core → security / registry / observability / bus → gpu → serving

Verify GPU nodes:
  kubectl get nodes -l nvidia.com/gpu.present=true
  kubectl -n gpu-operator get pods

EOF
