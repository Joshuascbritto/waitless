# Kubernetes runbook

Why k3s and Kustomize: [ADR-0008](../../docs/adr/0008-k3s-on-one-vps-with-kustomize.md). What runs: [SPEC §14](../../docs/SPEC.md#14-deployment-and-ci).

```
deploy/k8s/
├── base/                        app: api (2 replicas, PDB), worker, web, Ingress,
│                                bootstrap-roles + migrate Jobs, demo-reset CronJob
├── components/in-cluster-data/  Postgres + Redis StatefulSets (drop for managed services)
├── overlays/local/              k3d on your machine, local images
├── overlays/prod/               the VPS: GHCR images, TLS, settings.env (public host)
│   └── cluster/                 one-time cluster setup: ClusterIssuer, Traefik
└── deploy.sh                    applies an overlay in stages
```

`deploy.sh` applies resources by their `waitless.dev/stage` label and waits at each step:

1. `infra`: namespace, config, secrets, Postgres and Redis (until ready)
2. `bootstrap`: the role bootstrap Job (`deploy/postgres/initdb/10-roles.sh`, as the superuser)
3. `migrate`: the migration Job (as `waitless_owner`)
4. `app`: API, worker, web, Ingress, CronJob (until rolled out)

New code therefore never runs against an old schema. Migrations run while the previous release is still serving, so they must stay backward compatible with it (expand, then contract).

## Local cluster (k3d)

Needs Docker, [k3d](https://k3d.io) and `kubectl` (Kustomize is built in).

```bash
docker build -f deploy/docker/api.Dockerfile -t waitless-api:local .
docker build -f deploy/docker/web.Dockerfile -t waitless-web:local .
k3d cluster create waitless --image rancher/k3s:v1.37.2-k3s1 --agents 1 -p "8080:80@loadbalancer" --wait
k3d image import waitless-api:local waitless-web:local -c waitless
deploy/k8s/deploy.sh deploy/k8s/overlays/local

# Demo data now, instead of waiting for the 03:00 CronJob:
kubectl -n waitless create job --from=cronjob/demo-reset demo-reset-now
```

Open http://localhost:8080 and log in as `owner@demo.waitless.dev` / `demo1234`. After rebuilding an image: import it again and `kubectl -n waitless rollout restart deploy/api deploy/worker` (or `deploy/web`). Remove everything with `k3d cluster delete waitless`.

The `local` overlay's credentials are the same throwaway values docker compose uses.

## Go-live checklist

Everything is built, tested and pushed to GHCR on every green `main`; only the server is missing. When there is one, these are the only places to edit:

| Where | What to change |
|---|---|
| [`overlays/prod/settings.env`](overlays/prod/settings.env) | `HOST`: the demo's domain (e.g. a subdomain of your site), with a DNS `A` record pointing at the VPS |
| [`overlays/prod/cluster/cluster-issuer.yaml`](overlays/prod/cluster/cluster-issuer.yaml) | `email`: where Let's Encrypt sends expiry warnings |
| `overlays/prod/secrets.env`, `overlays/prod/postgres.env` | Create from the `*.example` files next to them; strong passwords, VAPID keys (gitignored) |
| `overlays/prod/ghcr.dockerconfigjson` | Image pull credentials (step 6 below), or make both GHCR packages public and skip the token |
| GitHub → Settings → Secrets and variables → Actions | Variables `DEPLOY_ENABLED=true` and `DEMO_URL`; environment `production` with the four secrets listed under [Deploys from GitHub Actions](#deploys-from-github-actions) |
| [`README.md`](../../README.md) (the "Live demo" line) | The public URL |
| [`docs/ROADMAP.md`](../../docs/ROADMAP.md) | Tick "Public demo URL live with HTTPS" |

Then follow the steps below once; after that, every green push to `main` deploys itself.

## Production (one VPS with k3s)

One-time setup. Commands run on your machine unless they say otherwise.

1. **VPS and DNS.** Any Linux VPS with 2 vCPU / 4 GB is enough. Point an `A` record for the demo host at it, then set that host in `overlays/prod/settings.env`.
2. **k3s** (on the VPS): `curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.37.2+k3s1 sh -`. Copy `/etc/rancher/k3s/k3s.yaml` to your machine and replace `127.0.0.1` with the VPS address. Keep the API port (6443) reachable only from where you deploy, or from GitHub Actions if it deploys.
3. **cert-manager:** `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.3/cert-manager.yaml`, then wait until `kubectl -n cert-manager get pods` shows it running.
4. **Cluster settings:** put your email in `overlays/prod/cluster/cluster-issuer.yaml` (Let's Encrypt expiry warnings), then `kubectl apply -k deploy/k8s/overlays/prod/cluster`. This keeps client IPs (rate limits need them) and adds the HTTP → HTTPS redirect.
5. **Secrets.** Copy `secrets.env.example` → `secrets.env` and `postgres.env.example` → `postgres.env` in `overlays/prod/` and fill in strong passwords (both files are gitignored; the passwords must match each other). For push notifications, add the output of `pnpm vapid:generate`.
6. **Image pull secret.** GHCR packages start private even when the repository is public. Either make `waitless-api` and `waitless-web` public (each package's settings → Danger Zone → Change visibility) and write `{"auths":{}}` to `overlays/prod/ghcr.dockerconfigjson`, or create a classic token with only `read:packages` and write the file from it (gitignored):

   ```bash
   kubectl create secret docker-registry ghcr-pull --docker-server=ghcr.io \
     --docker-username=<github user> --docker-password=<token> \
     --dry-run=client -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d > deploy/k8s/overlays/prod/ghcr.dockerconfigjson
   ```

7. **First deploy** (after `release.yml` has pushed images for `main`): `deploy/k8s/deploy.sh deploy/k8s/overlays/prod`. Certificates take a minute or two after the Ingress exists.

### Deploys from GitHub Actions

`release.yml` builds and pushes both images after every green CI run on `main`, then deploys that commit when deploying is enabled:

- Repository variable `DEPLOY_ENABLED` = `true`, and optionally `DEMO_URL` (shown on the deployment).
- Environment `production` with these secrets:
  - `KUBECONFIG`: the edited `k3s.yaml`.
  - `PROD_SECRETS_ENV` and `PROD_POSTGRES_ENV`: the contents of `secrets.env` and `postgres.env`.
  - `GHCR_PULL_DOCKERCONFIGJSON`: the contents of `ghcr.dockerconfigjson`.

The workflow writes those files on the runner, pins both images to the commit SHA with a throwaway overlay on top of `prod`, and runs `deploy.sh`.

## Operating it

- **Logs:** `kubectl -n waitless logs deploy/api -f` (JSON, one line per event; pipe through `pino-pretty` to read).
- **Metrics:** API and worker serve Prometheus metrics on port 9464 (`/metrics`), never through the Ingress. Pods carry `prometheus.io/scrape` annotations. Quick look: `kubectl -n waitless port-forward deploy/api 9464` and open http://localhost:9464/metrics.
- **Reset the demo now:** `kubectl -n waitless create job --from=cronjob/demo-reset demo-reset-$(date +%s)`.
- **Roll back:** `kubectl -n waitless rollout undo deploy/api deploy/worker deploy/web`, as long as the schema is still compatible (see the migration rule above).
- **Database shell:** `kubectl -n waitless exec -it postgres-0 -- psql -U postgres -d waitless`.
- **Before real customer data:** add backups (a nightly `pg_dump` CronJob to object storage), or move Postgres to a managed service by dropping `components/in-cluster-data` and changing the two connection strings.
