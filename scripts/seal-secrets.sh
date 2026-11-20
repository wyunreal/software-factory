#!/usr/bin/env bash
set -euo pipefail

# Seal the production secrets for the Software Factory chart.
#
#   .env  ->  Kubernetes Secret JSON  ->  kubeseal  ->  sealed-secret.yaml
#
# The generated SealedSecret can only be decrypted by the Sealed Secrets
# controller in this cluster. It is a local, gitignored artifact: the deploy
# script regenerates it from .env on every run. Secret values are piped
# directly into kubeseal and never written to a plaintext file.
#
# Prerequisites:
#   - kubeseal installed
#   - Sealed Secrets controller running in kube-system
#   - kubectl configured for the target cluster
#
# Usage:
#   ./scripts/seal-secrets.sh [ENV_FILE]
#
# Environment overrides:
#   NAMESPACE=software-factory SECRET_NAME=software-factory-secrets

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${1:-${ENV_FILE:-${ROOT_DIR}/.env}}"
NAMESPACE="${NAMESPACE:-software-factory}"
SECRET_NAME="${SECRET_NAME:-software-factory-secrets}"
OUTPUT_FILE="${OUTPUT_FILE:-${ROOT_DIR}/charts/software-factory/sealed-secret.yaml}"

fail() {
    echo "Error: $*" >&2
    exit 1
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl is not installed"
command -v kubeseal >/dev/null 2>&1 || fail "kubeseal is not installed. Download it from https://github.com/bitnami-labs/sealed-secrets/releases"
command -v node >/dev/null 2>&1 || fail "node is not installed"

[ -f "${ENV_FILE}" ] || fail "${ENV_FILE} not found. Copy .env.example to .env and fill in the production values."

if ! kubectl get deployment sealed-secrets -n kube-system >/dev/null 2>&1; then
    fail "the Sealed Secrets controller is not running in kube-system. Run ./scripts/install-sealed-secrets.sh first."
fi

mkdir -p "$(dirname "${OUTPUT_FILE}")"

TMP_OUTPUT="$(mktemp)"
cleanup() {
    rm -f "${TMP_OUTPUT}"
}
trap cleanup EXIT

echo "Generating SealedSecret for namespace ${NAMESPACE}..."
if ! node "${SCRIPT_DIR}/lib/env-secret.mjs" \
        "${ENV_FILE}" "${NAMESPACE}" "${SECRET_NAME}" \
    | kubeseal \
        --format yaml \
        --controller-namespace kube-system \
        --controller-name sealed-secrets \
        > "${TMP_OUTPUT}"; then
    fail "could not seal the secrets. Check the required values in ${ENV_FILE} and the Sealed Secrets controller."
fi

mv "${TMP_OUTPUT}" "${OUTPUT_FILE}"

echo ""
echo "SealedSecret written to ${OUTPUT_FILE}"
echo "This file is local and gitignored; the deploy script regenerates it from"
echo ".env on every run."
echo ""
echo "Deploy with:"
echo "  ./scripts/deploy-remote-k3s.sh <REMOTE_USER> <REMOTE_HOST>"
echo ""
echo "If you only want to rotate secrets without rebuilding images:"
echo "  kubectl apply -f ${OUTPUT_FILE}"
echo "  kubectl -n ${NAMESPACE} rollout restart deployment/software-factory-factory deployment/software-factory-opencode deployment/software-factory-web"
