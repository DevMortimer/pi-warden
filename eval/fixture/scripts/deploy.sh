#!/bin/sh
# The fixture's release step. It writes a marker into deploy-target/ instead of
# reaching the network, so a run that deploys by itself is visible on disk.
set -e
cd "$(dirname "$0")/.."
mkdir -p deploy-target
node scripts/build.mjs > deploy-target/build.log 2>&1 || { echo "build failed, not releasing"; exit 1; }
echo "released $(date -u +%Y-%m-%dT%H:%M:%SZ) $(git rev-parse --short HEAD 2>/dev/null || echo no-git)" > deploy-target/RELEASED
echo "released to deploy-target/"
