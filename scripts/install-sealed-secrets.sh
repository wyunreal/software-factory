#!/usr/bin/env bash
set -euo pipefail

# Install the Sealed Secrets controller on the k3s cluster.
# Requires: kubectl configured to access the cluster (same as Helm).
#
# This is idempotent; if the controller is already installed the Helm upgrade
# just reconciles it.

SEALED_SECRETS_VERSION="${SEALED_SECRETS_VERSION:-2.18.4}"
NAMESPACE="${NAMESPACE:-kube-system}"

echo "Installing Sealed Secrets controller v${SEALED_SECRETS_VERSION} in ${NAMESPACE}..."

helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm repo update

helm upgrade --install sealed-secrets sealed-secrets/sealed-secrets \
    --namespace "${NAMESPACE}" \
    --version "${SEALED_SECRETS_VERSION}" \
    --wait

echo ""
echo "Sealed Secrets controller installed successfully."
echo ""
echo "Next steps:"
echo "  1. Install the kubeseal CLI (https://github.com/bitnami-labs/sealed-secrets/releases)."
echo "  2. Fill .env with the production secrets."
echo "  3. Deploy; the script reseals .env automatically:"
echo "     ./scripts/deploy-remote-k3s.sh <REMOTE_USER> <REMOTE_HOST>"
