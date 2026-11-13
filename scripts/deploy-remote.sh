#!/usr/bin/env bash
# Select a release, then use the same procedure as a first installation.
set -euo pipefail
TAG="${1:?Usage: deploy-remote.sh fulfillment-vX.Y.Z}"
[[ "$TAG" =~ ^fulfillment-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid release tag' >&2; exit 1; }
cd "${APP_DIR:-/opt/fulfillment}"
[[ -z "$(git status --porcelain)" ]] || { echo 'Deployment checkout has local changes; refusing to overwrite' >&2; exit 1; }
git fetch --tags origin
git checkout --detach "$TAG"
exec node scripts/production.mjs deploy
