#!/usr/bin/env bash
set -euo pipefail

# Enable the host-level Tailscale Funnel for the public GitHub webhook.
#
# Prerequisites:
#   - kubectl configured for the target k3s cluster
#   - SSH access to the host and sudo for `tailscale funnel`
#   - Tailscale running on the host, with HTTPS Certificates enabled and a
#     nodeAttrs `funnel` attribute that covers this node
#   - the chart deployed with web.tailscaleFunnel.enabled=true
#
# Usage:
#   ./scripts/enable-tailscale-funnel.sh <REMOTE_USER> <REMOTE_HOST>
#
# Example:
#   ./scripts/enable-tailscale-funnel.sh wyunreal 192.168.68.50

NAMESPACE="software-factory"
SERVICE="web-webhook"
WEBHOOK_PATH="/api/github/webhook"
# 8443 instead of 443: this host also serves other HTTPS ingresses on 443
# (for example cd-manager on its Tailscale IP). Funnel supports 443, 8443
# and 10000.
HTTPS_PORT="8443"

usage() {
    echo "Usage: $0 <REMOTE_USER> <REMOTE_HOST>"
    echo "Example: $0 wyunreal 192.168.68.50"
}

fail() {
    echo "Error: $*" >&2
    exit 1
}

if [ "$#" -eq 1 ] && { [ "$1" = "--help" ] || [ "$1" = "-h" ]; }; then
    usage
    exit 0
fi

if [ "$#" -ne 2 ]; then
    usage
    exit 1
fi

REMOTE_USER="$1"
REMOTE_HOST="$2"
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"

for command in kubectl ssh; do
    command -v "${command}" >/dev/null 2>&1 || fail "${command} is not installed"
done

NODE_PORT="$(kubectl -n "${NAMESPACE}" get service "${SERVICE}" \
    -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true)"
if [ -z "${NODE_PORT}" ]; then
    fail "Service ${SERVICE} not found in namespace ${NAMESPACE}. Deploy the chart with web.tailscaleFunnel.enabled=true first."
fi

ssh "${REMOTE}" "tailscale status >/dev/null 2>&1" \
    || fail "Tailscale is not running or not reachable on ${REMOTE}."

echo "⏳ Waiting for ${SERVICE}:${NODE_PORT}${WEBHOOK_PATH} to answer with 401..."
HTTP_CODE=""
for _ in $(seq 1 30); do
    HTTP_CODE="$(ssh "${REMOTE}" \
        "curl -s -o /dev/null --max-time 5 -w '%{http_code}' -X POST http://127.0.0.1:${NODE_PORT}${WEBHOOK_PATH}" \
        2>/dev/null || true)"
    [ "${HTTP_CODE}" = "401" ] && break
    sleep 2
done
if [ "${HTTP_CODE}" != "401" ]; then
    fail "Expected HTTP 401 from http://127.0.0.1:${NODE_PORT}${WEBHOOK_PATH} on ${REMOTE}, got '${HTTP_CODE}'. Check the web Service, pod readiness and GITHUB_APP_WEBHOOK_SECRET before exposing it with Funnel."
fi

# Funnel and Serve share the same mount table. Refuse to enable Funnel when
# the host already has unrelated mounts, because Funnel can expose more than
# the path configured here.
if ! SERVE_STATUS="$(ssh "${REMOTE}" "tailscale serve status 2>&1")"; then
    fail "Could not read Tailscale serve status on ${REMOTE}."
fi
MOUNT_COUNT="$(printf '%s\n' "${SERVE_STATUS}" | grep -c '^|-- ' 2>/dev/null || true)"
if [ "${MOUNT_COUNT}" -gt 1 ]; then
    fail "The host has multiple Tailscale serve/funnel mounts. Review 'tailscale serve status' on ${REMOTE} before enabling Funnel."
fi
if [ -n "${SERVE_STATUS}" ] && [ "${SERVE_STATUS}" != "No serve config" ] \
    && ! printf '%s\n' "${SERVE_STATUS}" | grep -qF "${WEBHOOK_PATH}"; then
    fail "The host already has unrelated Tailscale serve/funnel configuration. Review 'tailscale serve status' on ${REMOTE} before enabling Funnel."
fi

echo "🌐 Enabling Tailscale Funnel for ${WEBHOOK_PATH} -> 127.0.0.1:${NODE_PORT}${WEBHOOK_PATH}..."
ssh -t "${REMOTE}" "sudo tailscale funnel --bg --yes --https=${HTTPS_PORT} \
    --set-path=${WEBHOOK_PATH} \
    http://127.0.0.1:${NODE_PORT}${WEBHOOK_PATH}"

echo ""
ssh "${REMOTE}" "tailscale funnel status"
echo ""
echo "👉 Point the GitHub App webhook URL at the https://<host>.<tailnet>.ts.net:${HTTPS_PORT}${WEBHOOK_PATH}"
echo "   URL shown above."
echo "👉 Keep FACTORY_PR_POLLING=true until a real delivery returns 202."
