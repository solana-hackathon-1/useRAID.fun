#!/usr/bin/env bash
# Called only after checks/build/smoke pass; GITHUB_TOKEN stays outside this script.
set -euo pipefail
image=${1:?Usage: staging-publish.sh local-image}
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 64
registry_image="ghcr.io/$(printf '%s' "$GITHUB_REPOSITORY" | tr '[:upper:]' '[:lower:]')"
docker tag "$image" "$registry_image:sha-$GITHUB_SHA"
docker push "$registry_image:sha-$GITHUB_SHA"

# A superseded build may retain its immutable artifact but cannot deploy staging.
current=$(git ls-remote origin refs/heads/main | cut -f1 | cut -d' ' -f1)
if [[ "$current" != "$GITHUB_SHA" ]]; then
  printf '%s\n' 'Main advanced; skipping staging promotion.'
  exit 0
fi
docker tag "$image" "$registry_image:staging"
docker push "$registry_image:staging"
