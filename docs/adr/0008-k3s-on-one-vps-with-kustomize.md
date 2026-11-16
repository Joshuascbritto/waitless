# 0008. Deployment: k3s on one VPS with Kustomize
Date: 2026-11-16
Status: Accepted

## Context

Waitless needs a public demo with HTTPS, and the deployment should show how it would run for real: several API replicas (the SSE fan-out in ADR-0004 only matters with more than one), a separate worker, migrations before rollout, probes and graceful shutdown. It is a portfolio project, so the monthly cost has to stay near the price of a small VPS, and every piece should be explainable in an interview.

## Options considered

1. **A PaaS** (Render, Fly.io, Railway)
   - Pros: least operational work; managed TLS, Postgres and Redis.
   - Cons: several paid services add up past a hobby budget; long-lived SSE connections and a background worker are second-class on some of them; it shows little about how the system is operated.
2. **Docker Compose on a VPS**
   - Pros: already exists (the `full` profile: 2 API replicas, worker, Caddy); simplest to run.
   - Cons: no rolling updates, health-based restarts or rollout ordering beyond `depends_on`; a deploy is "stop, pull, start".
3. **Managed Kubernetes** (GKE, EKS, AKS, DOKS)
   - Pros: the real thing, with managed control plane and load balancers.
   - Cons: the control plane or the load balancer alone costs more than the whole demo should.
4. **k3s on one VPS, manifests with Kustomize**
   - Pros: real Kubernetes APIs (Deployments, PDB, Jobs, CronJobs, Ingress, probes) for the price of one VPS; k3s ships Traefik and local-path storage; the same manifests run on a laptop with k3d and on any conformant cluster.
   - Cons: one node is a single point of failure; we run Postgres and Redis ourselves (backups are on us); TLS needs cert-manager.
5. **Helm instead of Kustomize** (with option 4)
   - Pros: templating, a packaging format, chart ecosystem.
   - Cons: Go templates over YAML are harder to read and review; we have one app with two environments, which is exactly what Kustomize overlays are for, and it's built into `kubectl`.

## Decision

k3s on one VPS, with plain manifests and Kustomize overlays (`deploy/k8s`):

- `base/` holds the app: API (2 replicas, PDB, spread), worker, web, Ingress, the role-bootstrap and migration Jobs, the demo-reset CronJob.
- `components/in-cluster-data` adds Postgres and Redis as StatefulSets. Moving to managed services means dropping the component and changing two connection strings.
- `overlays/local` (k3d) and `overlays/prod` (GHCR images pinned to the commit SHA, cert-manager TLS, host from one settings file).
- `deploy.sh` applies by stage label: infra → roles → migrations → app, waiting at each step. Kubernetes has no built-in "run this Job before that Deployment", and an init container on every API pod would race migrations across replicas.
- `release.yml` builds and pushes images after CI passes on `main`, then runs `deploy.sh`. Deploying is gated by a repository variable, so the pipeline works before a cluster exists.

## Consequences

- Easier: the demo exercises the real production concerns (two replicas behind an Ingress, zero-downtime rollouts with `maxUnavailable: 0` and a `preStop` delay, migrations ahead of code); local k3d reproduces it.
- Harder: we own the database. Backups (a nightly `pg_dump` CronJob to object storage) are the first thing to add before any real customer data; the demo's data is regenerated nightly anyway.
- Migrations run before the new code, while the old code is still serving, so each migration must be backward compatible with the previous release (expand, then contract).
- Revisit when the demo needs high availability or holds real data: move Postgres and Redis to managed services (drop the component), and run more than one node, or move the same manifests to a managed cluster.
