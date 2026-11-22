# Kubernetes / k3s deployment

This guide describes the production deployment of Software Factory on the
home k3s cluster. It follows the same pattern as
`smart-cd-player/cd-manager`: images are built locally, copied to the k3s host,
imported into containerd, and deployed with Helm. HTTPS is issued by the
cluster-wide cert-manager `ClusterIssuer` `letsencrypt-prod` using the Porkbun
DNS-01 webhook.

## Topology

Everything lives in the `software-factory` namespace:

| Workload | Service | Exposure |
| --- | --- | --- |
| Next.js webapp | `web:8080` | **Public HTTPS Ingress**; optional NodePort for Tailscale Funnel |
| Factory orchestrator | `factory:3000` | ClusterIP only |
| OpenCode runtime | `opencode:4096` | ClusterIP only |
| PostgreSQL 17 | `postgres:5432` | ClusterIP only |

Only the webapp is exposed outside the cluster. The browser authenticates to
the webapp, and the webapp proxies `/api/*` to the factory API with the internal
bearer token. The public GitHub webhook also enters through the webapp at
`https://web.factory.warias.app/api/github/webhook`.

The factory and OpenCode containers share the `software-factory-data` PVC at
`/data`, so git worktrees created by the orchestrator are visible to the agents.
The OpenCode config and squad profiles are baked into the image under `/config`.

## Prerequisites

On the machine where you run the deploy:

- Docker
- `kubectl` configured for the cluster (`kubectl get nodes` must work)
- Helm 3
- `kubeseal` (Sealed Secrets CLI)
- SSH key access to the k3s host; `k3s ctr images import` is run with `sudo`
- `npm` (the deploy script bumps the patch version)
- Several GB of free disk on the k3s host for the imported images. The shared
  factory/OpenCode image is large (it contains the OpenCode CLI); the deploy
  script transfers and imports one image at a time to limit peak usage.

In the cluster:

- Traefik ingress controller (default in k3s)
- cert-manager with the `letsencrypt-prod` ClusterIssuer and the Porkbun
  webhook. This is the same installation used by
  `smart-cd-player/cd-manager`; see its `docs/https-setup.md`.
- Sealed Secrets controller. Install it once with:

  ```bash
  ./scripts/install-sealed-secrets.sh
  ```

Verify the shared pieces:

```bash
kubectl get clusterissuer letsencrypt-prod
kubectl get ingressclass
kubectl get deployment sealed-secrets -n kube-system
```

## DNS

Create an `A` record (or a local DNS override) for:

```text
web.factory.warias.app -> 192.168.68.50
```

`192.168.68.50` is the Traefik address of the current cluster. If you access
the cluster from outside the LAN, point the record at your public IP and
forward ports 80/443. The certificate itself uses DNS-01, so it can be issued
before the `A` record is correct, but browsers need the record to reach the
webapp.

Do **not** create a record for `factory.warias.app`; the factory API is not
exposed by this chart.

## Secrets

Secrets never enter the chart, the Helm release, or git in plaintext.

```text
.env  ->  scripts/seal-secrets.sh  ->  charts/software-factory/sealed-secret.yaml (local, gitignored)
      ->  kubectl apply             ->  Secret software-factory-secrets
```

`seal-secrets.sh` reads the local `.env`, builds a Kubernetes Secret, and pipes
it through `kubeseal`. The generated `sealed-secret.yaml` is encrypted with the
cluster key, but it is a **local, gitignored artifact**: the deploy script
regenerates it from `.env` on every run. Do not commit it (or
`charts/software-factory/secrets.yaml`). The Sealed Secrets controller decrypts
it into the `software-factory-secrets` Secret in the `software-factory`
namespace.

Required values in `.env`:

```text
POSTGRES_PASSWORD
DATABASE_URL              # postgres://factory:<password>@postgres:5432/factory
FACTORY_API_TOKEN         # >= 16 chars
OPENCODE_SERVER_PASSWORD
GITHUB_APP_ID
GITHUB_APP_SLUG
GITHUB_APP_WEBHOOK_SECRET
WEB_AUTH_SECRET           # >= 32 chars
GITHUB_APP_PRIVATE_KEY_BASE64   # or GITHUB_APP_PRIVATE_KEY
```

`GITHUB_APP_PRIVATE_KEY_PATH` is also accepted by the sealing script; it
inlines the file content into the Secret because the path does not exist inside
the cluster.

Optional keys (OAuth providers, `WEB_REGISTRATION_CODE`,
`WEB_DATABASE_URL`, provider API keys such as `OLLAMA_API_KEY`) are included
only when they are non-empty.

The chart deliberately has no plaintext Secret template. If
`secrets.existingSecret` is empty, Helm rendering fails instead of creating an
insecure Secret.

## First deployment

```bash
cp .env.example .env
$EDITOR .env

./scripts/install-sealed-secrets.sh   # only once per cluster
./scripts/deploy-remote-k3s.sh wyunreal 192.168.68.50
```

The deploy script seals the secrets itself. It regenerates the local,
gitignored `charts/software-factory/sealed-secret.yaml` from `.env` on every
run, so changing `.env` and redeploying is enough to rotate secrets.

The deploy script:

1. verifies `kubectl`, Helm, Docker, `kubeseal`, the Sealed Secrets controller,
   the Traefik IngressClass and the `letsencrypt-prod` ClusterIssuer;
2. creates the `software-factory` namespace;
3. runs `scripts/seal-secrets.sh` to regenerate the local sealed secret from
   `.env`, applies it and waits for the `software-factory-secrets` Secret;
4. verifies the required keys are present (without printing their values);
5. bumps the patch version in `package.json`;
6. builds `software-factory:<version>` and `software-factory-web:<version>`;
7. saves, compresses, copies and imports both images into k3s;
8. runs `helm upgrade --install` with both image tags.

## Verify

```bash
kubectl -n software-factory get pods,svc,ingress,certificate

kubectl -n software-factory logs -f deploy/software-factory-factory
kubectl -n software-factory logs -f deploy/software-factory-opencode
kubectl -n software-factory logs -f deploy/software-factory-web

curl -I https://web.factory.warias.app
```

The certificate is ready when:

```bash
kubectl -n software-factory get certificate
kubectl -n software-factory describe certificate software-factory-web-tls
```

The factory API stays internal. To inspect it from your machine, port-forward
it (this does not expose it publicly):

```bash
kubectl -n software-factory port-forward svc/factory 3000:3000
curl -H "Authorization: Bearer $FACTORY_API_TOKEN" http://127.0.0.1:3000/health
```

## GitHub App

Configure the App with the webapp URLs:

```text
Homepage URL: https://web.factory.warias.app
Webhook URL:  https://web.factory.warias.app/api/github/webhook
Setup URL:    https://web.factory.warias.app/api/github/install/callback
```

The webhook is public because it enters through the webapp; the factory
endpoint it forwards to is ClusterIP-only. Subscribe to the events documented
in the main README.

## Tailscale Funnel (no public IP)

When the k3s host is behind CGNAT or the webapp is LAN-only, GitHub cannot reach
`web.factory.warias.app`. The chart can create a NodePort that a host-level
Tailscale Funnel proxies to the public `*.ts.net` hostname. No DNS change is
needed and `warias.app` stays in Porkbun.

The k3s host must already be a Tailscale node. In the Tailscale admin console,
enable **MagicDNS** and **HTTPS Certificates**, and allow Funnel for the node
(`nodeAttrs` with `autogroup:member`, or the node's tag).

The chart creates `web-webhook` when `web.tailscaleFunnel.enabled=true`
(`nodePort: 30081` by default). The helper script performs the host-side
configuration, including a preflight that the NodePort answers with `401`:

```bash
./scripts/enable-tailscale-funnel.sh wyunreal 192.168.68.50
```

Or run it as part of a deployment:

```bash
./scripts/deploy-remote-k3s.sh --funnel wyunreal 192.168.68.50
```

The helper refuses to mix the webhook mount with unrelated Tailscale
serve/funnel mounts and uses `sudo` for the Funnel command.

The manual equivalent on the k3s host is:

```bash
# The NodePort must answer locally before configuring Funnel.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:30081/api/github/webhook
# 401: wrong signature, which means the webapp received the request.

sudo tailscale funnel --bg --https=8443 \
  --set-path=/api/github/webhook \
  http://127.0.0.1:30081/api/github/webhook

tailscale funnel status
```

This cluster uses HTTPS port **8443** because 443 is already used by other host
services. Funnel supports only 443, 8443 and 10000.

The public URL is:

```text
https://<host>.<tailnet>.ts.net:8443/api/github/webhook
```

Verify from a device outside the tailnet (for example, a phone on mobile data):
an unsigned `POST` must return `401`, not `404` or `502`. Then set the GitHub App
webhook to that URL.

Only `/api/github/webhook` is mounted; every other path returns `404`. Do not
forward the NodePort from the router: the public entry point is the Funnel
hostname, and the factory API remains ClusterIP-only.

After a real delivery returns `202`, set `FACTORY_PR_POLLING: "false"` in
`charts/software-factory/values.yaml` and redeploy. Keep polling enabled until
the Funnel is verified.

## Common operations

### Deploy a new version

```bash
./scripts/deploy-remote-k3s.sh wyunreal 192.168.68.50
```

Each deploy imports new image tags into k3s and leaves the old ones in
containerd. To keep only the current and previous versions after a successful
rollout:

```bash
./scripts/deploy-remote-k3s.sh --prune wyunreal 192.168.68.50
```

`--prune` waits for the factory, web and opencode rollouts, then removes only
old `software-factory` and `software-factory-web` tags. It never touches other
images. Do not use `crictl rmi --prune` instead: it can delete other locally
imported images that are not in a registry, such as `cd-manager` or
`composite-video-parser`.

### Change non-secret configuration

Edit `charts/software-factory/values.yaml` (for example `config.FACTORY_MODEL`
or the ingress host) and rerun the deploy script. Or apply a values override:

```bash
helm upgrade --install software-factory charts/software-factory \
  --namespace software-factory \
  --reuse-values \
  --set config.FACTORY_MODEL=ollama-cloud/another-model
```

### Rotate secrets

The normal path is to edit `.env` and redeploy; the deploy script reseals the
secrets before applying them:

```bash
$EDITOR .env
./scripts/deploy-remote-k3s.sh wyunreal 192.168.68.50
```

For a secret-only rotation without rebuilding images:

```bash
$EDITOR .env
./scripts/seal-secrets.sh
kubectl apply -f charts/software-factory/sealed-secret.yaml
kubectl -n software-factory rollout restart \
  deployment/software-factory-factory \
  deployment/software-factory-opencode \
  deployment/software-factory-web
```

The controller updates the Secret. A rollout restart is required because
environment variables are only read when a container starts.

Rotating `POSTGRES_PASSWORD` after the database has been initialized is a
special case: `initdb` only uses it on the first boot. Change the role password
inside PostgreSQL as well, or recreate the volume, and keep `DATABASE_URL`
consistent with the new password.

### Inspect or update the Secret

```bash
kubectl -n software-factory get secret software-factory-secrets
kubectl -n software-factory get secret software-factory-secrets \
  -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}'
```

Never use `kubectl get secret -o yaml` in logs or screenshots; it contains
base64 values.

### Persistent data

| PVC | Contents |
| --- | --- |
| `software-factory-postgres` | PostgreSQL data |
| `software-factory-data` | `/data`: repos, worktrees, OpenCode state/cache |

Both use the default `local-path` storage class. They are node-local and
`ReadWriteOnce`; the factory and OpenCode pods must run on the same node. The
current cluster is single-node, so this is satisfied. On a multi-node cluster,
use RWX storage or pin both pods to one node.

Back up the database before upgrades or uninstalls:

```bash
kubectl -n software-factory exec deploy/software-factory-postgres -- \
  pg_dump -U factory -d factory > software-factory-backup.sql
```

`helm uninstall` deletes chart-managed PVCs. Back up before uninstalling, or
delete the release only after copying the volumes.

### Uninstall

```bash
./scripts/uninstall-k8s.sh
```

The SealedSecret and the Secret it created are left in the namespace on
purpose. Delete the namespace only when you want to remove the credentials and
all remaining data:

```bash
kubectl delete namespace software-factory
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ErrImagePull` / `ImagePullBackOff` | image not imported into k3s | rerun the deploy script; check `sudo k3s ctr images ls \| grep software-factory` |
| `CreateContainerConfigError` | missing key in `software-factory-secrets` | update `.env` and rerun the deploy script; it reseals, applies and restarts |
| Helm fails with `secrets.existingSecret is required` | chart rendered without the Secret reference | pass `--set secrets.existingSecret=software-factory-secrets` |
| Certificate stays `False` | DNS-01/Porkbun problem | `kubectl -n software-factory describe certificate ...`; `kubectl logs -n cert-manager deploy/cert-manager`; Porkbun webhook logs |
| Browser cannot reach HTTPS | missing/wrong DNS A record | point `web.factory.warias.app` at the Traefik address |
| Webapp returns 502 | factory not ready or crashed | `kubectl -n software-factory logs deploy/software-factory-factory` |
| Factory exits at startup | missing GitHub App key or wrong config | inspect logs; verify the Secret keys and `GITHUB_APP_PRIVATE_KEY_BASE64` |
| OpenCode health 401 | password mismatch between factory and opencode | reseal the same `OPENCODE_SERVER_PASSWORD`, apply, restart both |
| App cannot connect to Postgres | `DATABASE_URL` points elsewhere | it must use host `postgres`, port `5432`, database/user from values |
| Postgres crashes on first boot | volume permissions or mismatched secret | inspect `kubectl -n software-factory logs deploy/software-factory-postgres`; the PVC is local-path |
| Pods pending | PVC/node scheduling | `kubectl -n software-factory describe pod`; the cluster is single-node and local-path |
