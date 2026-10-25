# ADR-0014: The web SDK ships as a tarball on GitHub releases; the Rust SDK stays a git dependency

## Status
Accepted. Supersedes the "projects consume the SDKs as git dependencies" part of ADR-0007 for the web SDK.

## Date
2026-10-25

## Context
ADR-0007 keeps both SDKs unpublished until `v0.1.0` and has projects consume them as git dependencies of this
repository. A spike on fresh apps (2026-10-25) showed this works for Rust and for the web SDK with pnpm or Yarn, but
not with npm: npm ignores the `#path:` part of a git dependency and installs the repository root, so the import of
`chepio-lens-web` fails. The web SDK also ships its TypeScript source, so an app type-checks it with its own compiler
options; Vite's React + TypeScript template enables `erasableSyntaxOnly`, which rejected a parameter property in the SDK
and broke the template's `build`.

## Decision
- On every `v*` tag, `.github/workflows/release.yml` creates the GitHub release and attaches
  `chepio-lens-web-<version>.tgz`, packed by `sdk/web/pack.sh`: the TypeScript source without tests, `package.json` with
  the tag's version, and both license texts. Apps install it by URL with any package manager (owner's decision,
  2026-10-25). Nothing is published to npm (ADR-0007 stands for that).
- Before the first release, and for unreleased commits, the web SDK is installed with pnpm or Yarn from the git
  subdirectory (`github:chepiotech/chepio-lens#<commit>&path:/sdk/web`).
- The Rust SDK remains a git dependency, pinned with `tag = "v…"` (or `rev` before the first tag); Cargo resolves the
  workspace package and its path dependency `chepio-lens-conventions`.
- The web SDK stays TypeScript source (no build step). `tsconfig.base.json` sets `erasableSyntaxOnly` so the
  repository fails the same way an app would, and CI runs `sdk/web/pack-check.sh`: the tarball installs with npm into
  an empty app and type-checks with the template's strict flags.

## Rationale
- A release asset is one versioned URL that npm, pnpm and Yarn all accept, without a registry account or a publish
  that cannot be undone.
- Shipping source avoids a build pipeline and source maps; the pack check keeps it compiling under strict app settings.
- Rust needs nothing new: git dependencies are first-class in Cargo.

## Alternatives considered
- **Git dependencies only**: nothing to release, but npm projects cannot install the web SDK; they would need a local
  clone and `npm install --install-links <clone>/sdk/web`, which writes a relative path into every developer's
  `package.json`.
- **Publish to npm at `v0.1.0`**: the most familiar install, but a published version cannot be withdrawn and the SDK
  API has not been tried on a real project yet (ADR-0007).
- **Ship compiled JavaScript with `.d.ts`**: independent of the app's compiler options, but adds a build, generated
  files and source maps to keep in sync; reconsider if a real app's settings break the source again.

## Consequences
- Easier: the guide gives one install line per package manager; npm works.
- Constrained: an app on an unreleased commit needs pnpm or Yarn. Each tag (and with it each release asset and image)
  is an owner decision. The release job runs for the first time on the first tag.
- The web SDK source must stay erasable TypeScript; CI enforces it.

## Validation / fitness criteria
- CI: `sdk/web/pack-check.sh` passes; the tarball contains the license texts and no tests.
- The connection guide, followed on fresh apps, installs both SDKs as written.

## Reconsider when
- npm publishing is decided (ADR-0007), or a real app's compiler settings reject the source.

## References
- `../../sdk/web/pack.sh`, `../../sdk/web/pack-check.sh`, `../../.github/workflows/release.yml`; ADR-0007, ADR-0011
