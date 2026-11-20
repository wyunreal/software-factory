# Software Factory Helm chart

This chart deploys the complete Software Factory stack into the
`software-factory` namespace:

| Workload | Service | Exposure |
| --- | --- | --- |
| Next.js webapp | `web:8080` | HTTPS Ingress (the only public workload) |
| Factory orchestrator | `factory:3000` | ClusterIP only |
| OpenCode runtime | `opencode:4096` | ClusterIP only |
| PostgreSQL 17 | `postgres:5432` | ClusterIP only |

The factory and OpenCode containers share the `<release>-data` PVC at `/data`
so git worktrees are visible to the agents. The OpenCode config and agent
profiles are baked into the image under `/config`.

## Secrets

The chart does not create Secrets from plaintext values. It expects an existing
Secret named `software-factory-secrets`, created by the Sealed Secrets
controller.

`./scripts/deploy-remote-k3s.sh` regenerates
`charts/software-factory/sealed-secret.yaml` from `.env` on every run and applies
it before Helm. That file is a local, gitignored artifact; do not commit it.
Only `.env` stays on the developer machine and is never mounted into the
cluster.

For a secret-only rotation without rebuilding images:

```bash
./scripts/seal-secrets.sh
kubectl apply -f charts/software-factory/sealed-secret.yaml
kubectl -n software-factory rollout restart \
  deployment/software-factory-factory \
  deployment/software-factory-opencode \
  deployment/software-factory-web
```

The Secret is created in the `software-factory` namespace; each pod receives
only the keys it needs through `secretKeyRef`.

## Install

```bash
helm upgrade --install software-factory ./charts/software-factory \
  --namespace software-factory \
  --create-namespace \
  --set image.tag=<version> \
  --set web.image.tag=<version> \
  --set secrets.existingSecret=software-factory-secrets
```

Normally you use `./scripts/deploy-remote-k3s.sh <user> <host>`, which seals the
secrets, builds the images, imports them into k3s and runs Helm.

See [docs/kubernetes.md](../../docs/kubernetes.md) for the full guide.
