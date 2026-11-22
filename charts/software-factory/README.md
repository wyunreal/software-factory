# Software Factory Helm chart

This chart deploys the complete Software Factory stack into the
`software-factory` namespace:

| Workload | Service | Exposure |
| --- | --- | --- |
| Next.js webapp | `web:8080` | HTTPS Ingress (the only public workload) |
| Webhook NodePort | `web-webhook:30081` | Optional, loopback target for host-level Tailscale Funnel |
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
secrets, builds the images, imports them into k3s and runs Helm. Add `--prune`
to remove old `software-factory`/`software-factory-web` image tags after a
successful rollout, keeping the current and previous versions.

## Tailscale Funnel

`web.tailscaleFunnel.enabled` creates the `web-webhook` NodePort Service. It
exists so a host-level Tailscale Funnel can proxy the public GitHub webhook to
`http://127.0.0.1:30081/api/github/webhook` without exposing the factory API or
the rest of the webapp.

Run the helper from the repository root:

```bash
./scripts/enable-tailscale-funnel.sh <REMOTE_USER> <REMOTE_HOST>
```

Or enable it as part of a deployment:

```bash
./scripts/deploy-remote-k3s.sh --funnel <REMOTE_USER> <REMOTE_HOST>
```

The manual equivalent on the k3s host is:

```bash
sudo tailscale funnel --bg --https=8443 \
  --set-path=/api/github/webhook \
  http://127.0.0.1:30081/api/github/webhook
```

The public webhook URL includes the port:
`https://<host>.<tailnet>.ts.net:8443/api/github/webhook`. The cluster uses 8443
because 443 is already used by other host services.

Do not forward the NodePort from the router. Only the Funnel hostname is public,
and only the mounted webhook path is routed.

See [docs/kubernetes.md](../../docs/kubernetes.md) for the full guide.
