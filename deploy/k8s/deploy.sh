#!/usr/bin/env bash
# Applies an overlay in stages, so new code never runs against an old schema:
#   infra      namespace, config, secrets, Postgres and Redis (waits until ready)
#   bootstrap  role bootstrap Job (superuser, idempotent)
#   migrate    migration Job (waitless_owner)
#   app        API, worker, web, Ingress, CronJob (waits for the rollout)
# Usage: deploy/k8s/deploy.sh deploy/k8s/overlays/<local|prod>
set -euo pipefail

overlay="${1:?usage: deploy.sh <overlay directory>}"
namespace=waitless
timeout=300s
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT

kubectl kustomize "$overlay" >"$rendered"

stage() {
  kubectl apply -f "$rendered" --selector "waitless.dev/stage=$1"
}

# Jobs are immutable: delete the previous run before applying this one.
run_job() {
  local name="$1" stage="$2"
  kubectl -n "$namespace" delete job "$name" --ignore-not-found --wait=true
  stage "$stage"
  if ! kubectl -n "$namespace" wait --for=condition=complete "job/$name" --timeout="$timeout"; then
    kubectl -n "$namespace" logs "job/$name" --tail=50 || true
    echo "job/$name did not complete" >&2
    exit 1
  fi
}

echo "--- infra"
stage infra
for statefulset in $(kubectl -n "$namespace" get statefulsets -o name); do
  kubectl -n "$namespace" rollout status "$statefulset" --timeout="$timeout"
done

echo "--- bootstrap (roles)"
run_job bootstrap-roles bootstrap

echo "--- migrate"
run_job migrate migrate

echo "--- app"
stage app
for deployment in api worker web; do
  kubectl -n "$namespace" rollout status "deployment/$deployment" --timeout="$timeout"
done
echo "deployed $overlay"
