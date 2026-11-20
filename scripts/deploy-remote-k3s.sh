#!/usr/bin/env bash
set -euo pipefail

# Build the two Software Factory images locally, import them into the k3s
# cluster over SSH, apply the SealedSecret and deploy/upgrade the Helm release.
#
# Usage:
#   ./scripts/deploy-remote-k3s.sh <REMOTE_USER> <REMOTE_HOST>
#
# Example:
#   ./scripts/deploy-remote-k3s.sh wyunreal 192.168.68.50
#
# Prerequisites:
#   - Docker running locally
#   - kubectl and helm configured for the target cluster
#   - SSH access to the k3s host (sudo is used for `k3s ctr images import`)
#   - kubeseal and a populated .env; the script reseals the secrets on every
#     run and writes the local, gitignored
#     charts/software-factory/sealed-secret.yaml

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_NAME="software-factory"
WEB_IMAGE_NAME="software-factory-web"
RELEASE_NAME="software-factory"
NAMESPACE="software-factory"
CHART_PATH="${ROOT_DIR}/charts/software-factory"
SEALED_SECRET_FILE="${CHART_PATH}/sealed-secret.yaml"
SECRET_NAME="software-factory-secrets"

usage() {
    echo "Usage: $0 <REMOTE_USER> <REMOTE_HOST>"
    echo "Example: $0 wyunreal 192.168.68.50"
}

if [ "$#" -ne 2 ]; then
    usage
    exit 1
fi

REMOTE_USER="$1"
REMOTE_HOST="$2"
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"

fail() {
    echo "Error: $*" >&2
    exit 1
}

secret_has_key() {
    local key="$1"
    kubectl -n "${NAMESPACE}" get secret "${SECRET_NAME}" \
        -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}' \
        2>/dev/null | grep -qx "${key}"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
for command in docker kubectl helm npm scp ssh kubeseal; do
    command -v "${command}" >/dev/null 2>&1 || fail "${command} is not installed"
done

if ! docker info >/dev/null 2>&1; then
    if command -v sg >/dev/null 2>&1; then
        echo "Docker requires the 'docker' group; re-executing with sg docker..."
        exec sg docker -c "$(printf '%q ' "$0" "$@")"
    fi
    fail "Docker is not accessible. Add your user to the docker group or start Docker."
fi

kubectl get clusterissuer letsencrypt-prod >/dev/null 2>&1 \
    || fail "ClusterIssuer letsencrypt-prod not found. Install cert-manager and the Porkbun webhook as in smart-cd-player/cd-manager (see docs/kubernetes.md)."
kubectl wait --for=condition=Ready clusterissuer/letsencrypt-prod --timeout=15s >/dev/null 2>&1 \
    || fail "ClusterIssuer letsencrypt-prod is not Ready. Check cert-manager and the Porkbun webhook."

kubectl get ingressclass traefik >/dev/null 2>&1 \
    || fail "IngressClass traefik not found. The chart expects the k3s Traefik ingress controller."

kubectl get deployment sealed-secrets -n kube-system >/dev/null 2>&1 \
    || fail "Sealed Secrets controller not found in kube-system. Run ./scripts/install-sealed-secrets.sh first."

echo "🔒 Sealing secrets from .env..."
ENV_FILE="${ROOT_DIR}/.env" \
    NAMESPACE="${NAMESPACE}" \
    SECRET_NAME="${SECRET_NAME}" \
    OUTPUT_FILE="${SEALED_SECRET_FILE}" \
    "${SCRIPT_DIR}/seal-secrets.sh"

# ---------------------------------------------------------------------------
# Namespace and secrets
# ---------------------------------------------------------------------------
echo "🔐 Creating namespace and applying SealedSecret..."
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "${SEALED_SECRET_FILE}"

for _ in $(seq 1 30); do
    if kubectl -n "${NAMESPACE}" get secret "${SECRET_NAME}" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
kubectl -n "${NAMESPACE}" get secret "${SECRET_NAME}" >/dev/null \
    || fail "Sealed Secrets did not create ${SECRET_NAME} in ${NAMESPACE}. Check the controller logs."

required_keys=(
    POSTGRES_PASSWORD
    DATABASE_URL
    FACTORY_API_TOKEN
    OPENCODE_SERVER_PASSWORD
    GITHUB_APP_ID
    GITHUB_APP_SLUG
    GITHUB_APP_WEBHOOK_SECRET
    WEB_AUTH_SECRET
)
for key in "${required_keys[@]}"; do
    secret_has_key "${key}" || fail "Secret ${SECRET_NAME} is missing required key ${key}. Update .env and retry the deployment."
done
if ! secret_has_key GITHUB_APP_PRIVATE_KEY && ! secret_has_key GITHUB_APP_PRIVATE_KEY_BASE64; then
    fail "Secret ${SECRET_NAME} has no GitHub App private key. Set GITHUB_APP_PRIVATE_KEY_BASE64 in .env and retry the deployment."
fi

# ---------------------------------------------------------------------------
# Build and transfer images
# ---------------------------------------------------------------------------
echo "🆙 Bumping version (patch)..."
NEW_VERSION="$(cd "${ROOT_DIR}" && npm version patch --no-git-tag-version)"
IMAGE_TAG="${NEW_VERSION#v}"

echo "📦 Building ${IMAGE_NAME}:${IMAGE_TAG}..."
docker build \
    --platform linux/amd64 \
    --provenance=false \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    "${ROOT_DIR}"

echo "📦 Building ${WEB_IMAGE_NAME}:${IMAGE_TAG}..."
docker build \
    --platform linux/amd64 \
    --provenance=false \
    -t "${WEB_IMAGE_NAME}:${IMAGE_TAG}" \
    "${ROOT_DIR}/web"

echo "💾 Saving and transferring images one at a time..."
# Import one image at a time: the k3s host has limited free disk space and
# containerd expands each image while the tar is still present.
TARBALL=""
cleanup() {
    if [ -n "${TARBALL}" ]; then
        rm -f "${ROOT_DIR}/${TARBALL}"
    fi
}
trap cleanup EXIT

transfer_image() {
    local image="$1"
    local tarball="$2"

    TARBALL="${tarball}"
    docker save "${image}" | gzip > "${ROOT_DIR}/${TARBALL}"

    echo "📤 Copying ${image} to ${REMOTE}..."
    scp "${ROOT_DIR}/${TARBALL}" "${REMOTE}:/tmp/"

    echo "📥 Importing ${image} into k3s..."
    if ! ssh -t "${REMOTE}" "sudo k3s ctr images import /tmp/${TARBALL} && rm /tmp/${TARBALL}"; then
        ssh "${REMOTE}" "rm -f /tmp/${TARBALL}" >/dev/null 2>&1 || true
        fail "failed to import ${image} into k3s"
    fi

    rm -f "${ROOT_DIR}/${TARBALL}"
    TARBALL=""
}

transfer_image "${IMAGE_NAME}:${IMAGE_TAG}" "software-factory-image-${IMAGE_TAG}.tar.gz"
transfer_image "${WEB_IMAGE_NAME}:${IMAGE_TAG}" "software-factory-web-image-${IMAGE_TAG}.tar.gz"

# ---------------------------------------------------------------------------
# Helm
# ---------------------------------------------------------------------------
echo "⚓ Deploying with Helm..."
helm upgrade --install "${RELEASE_NAME}" "${CHART_PATH}" \
    --namespace "${NAMESPACE}" \
    --create-namespace \
    --set image.tag="${IMAGE_TAG}" \
    --set web.image.tag="${IMAGE_TAG}" \
    --set secrets.existingSecret="${SECRET_NAME}" \
    -f "${CHART_PATH}/values.yaml"

echo ""
echo "✅ Deployment complete! Version: ${IMAGE_TAG}"
echo ""
kubectl -n "${NAMESPACE}" get pods,svc,ingress,certificate

WEB_HOST="$(kubectl -n "${NAMESPACE}" get ingress \
    -l "app.kubernetes.io/instance=${RELEASE_NAME}" \
    -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || true)"
if [ -n "${WEB_HOST}" ]; then
    echo ""
    echo "👉 Webapp: https://${WEB_HOST}"
    echo "👉 GitHub webhook: https://${WEB_HOST}/api/github/webhook"
fi
echo ""
echo "Only the webapp is exposed. The factory API, OpenCode and PostgreSQL are"
echo "ClusterIP services inside the ${NAMESPACE} namespace."
