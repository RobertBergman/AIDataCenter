#!/usr/bin/env bash
# Phase 1: install Cluster API + Metal3 providers onto the management cluster.
# Requires: kubectl context pointing at seed mgmt cluster (k3s on seed01 is fine).
set -euo pipefail

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1"; exit 1; }; }
need kubectl
need clusterctl

K8S_VERSION="${K8S_VERSION:-v1.32.2}"
CAPI_VERSION="${CAPI_VERSION:-v1.9.5}"

export CLUSTER_TOPOLOGY=true
export EXP_CLUSTER_RESOURCE_SET=true

echo "==> Initializing Cluster API ${CAPI_VERSION}"
clusterctl init \
  --core "cluster-api:${CAPI_VERSION}" \
  --bootstrap "kubeadm:${CAPI_VERSION}" \
  --control-plane "kubeadm:${CAPI_VERSION}" \
  --infrastructure metal3

echo "==> Waiting for CAPI / CAPM3 pods"
kubectl -n capi-system wait --for=condition=Available deployment --all --timeout=300s
kubectl -n capm3-system wait --for=condition=Available deployment --all --timeout=300s || \
  kubectl -n metal3-system wait --for=condition=Available deployment --all --timeout=300s || true

echo "==> Ensuring metal3 namespace"
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: metal3
  labels:
    pod-security.kubernetes.io/enforce: privileged
EOF

echo "CAPI + Metal3 ready. Next: scripts/02-apply-cluster.sh"
