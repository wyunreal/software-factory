#!/usr/bin/env bash
set -euo pipefail

# Remove the Software Factory Helm release.
#
# This also deletes the chart-managed PVCs (PostgreSQL data and factory data).
# The SealedSecret and the Secret it created are intentionally left in the
# namespace so the credentials can be reused on the next install.

RELEASE_NAME="software-factory"
NAMESPACE="software-factory"

echo "Uninstalling ${RELEASE_NAME} from namespace ${NAMESPACE}..."
helm uninstall "${RELEASE_NAME}" --namespace "${NAMESPACE}"

echo ""
echo "Uninstallation initiated."
echo "The SealedSecret/Secret remains in ${NAMESPACE}."
echo "To remove everything, including persistent data:"
echo "  kubectl delete namespace ${NAMESPACE}"
