#!/usr/bin/env bash
# Installs the packed web SDK the way an npm project would and type-checks a call to it with the strict flags of
# Vite's React + TypeScript template (`erasableSyntaxOnly`, unused checks): the SDK ships TypeScript source, so the
# app's compiler checks it too. Needs the npm registry for the SDK's OpenTelemetry dependencies.
# Usage: sdk/web/pack-check.sh
set -euo pipefail

cd "$(dirname "$0")"
typescript=$(node -p "require('typescript/package.json').version")
app=$(mktemp -d)
trap 'rm -rf "$app"' EXIT
./pack.sh "$app/pack" >/dev/null
tarball=$(ls "$app"/pack/chepio-lens-web-*.tgz)

# Read the complete archive before matching: grep -q can close a pipe early and make tar fail under pipefail.
tar -tzf "$tarball" > "$app/contents.txt"
grep -qx 'package/LICENSE-APACHE' "$app/contents.txt" || { echo "FAIL: the tarball has no license texts" >&2; exit 1; }
if grep -q '\.test\.ts$' "$app/contents.txt"; then echo "FAIL: the tarball contains tests" >&2; exit 1; fi

cd "$app"
cat > package.json <<'JSON'
{ "name": "pack-check", "private": true, "type": "module" }
JSON
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["main.ts"]
}
JSON
cat > main.ts <<'TS'
import { initLens, type NodeMetadata } from 'chepio-lens-web'

const node: NodeMetadata = { technologies: ['react'], pages: ['/'],
  microfrontends: [{ name: 'Notes', framework: 'vue', pages: ['/notes'] }] }
const lens = initLens({ serviceName: 'pack-check', endpoint: '', node })
void lens.shutdown()
TS
npm install --silent --no-audit --no-fund "$tarball" "typescript@$typescript"
npx --no-install tsc -p tsconfig.json
echo "OK: $(basename "$tarball") installs with npm and type-checks with Vite's strict flags (TypeScript $typescript)"
