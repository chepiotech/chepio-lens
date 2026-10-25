#!/usr/bin/env bash
# Packs the web SDK as the tarball attached to GitHub releases (ADR-0014): the TypeScript source without tests and
# the license texts from the repository root. With a version (a release tag without its `v`), the tarball carries it;
# package.json in the working tree is left as it was.
# Usage: sdk/web/pack.sh <destination directory> [version]
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <destination directory> [version]" >&2; exit 2; }
mkdir -p "$1"
destination=$(cd "$1" && pwd)
version=${2:-}
cd "$(dirname "$0")"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -R package.json src "$stage/"
cp ../../LICENSE-MIT ../../LICENSE-APACHE "$stage/"
cd "$stage"
if [ -n "$version" ]; then npm pkg set "version=$version"; fi
npm pack --silent --pack-destination "$destination"
