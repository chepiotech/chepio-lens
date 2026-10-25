# ADR-0011: The collector ships as a multi-architecture image on GHCR from v* tags, or is installed from a clone

## Status
Accepted

## Date
2026-10-25

## Context
To connect their project, a developer needs a running collector on their own machine, Apple silicon or x86_64,
within the 15-minute connection budget (F4 in `../architecture/quality-attributes.md`). The collector binary embeds the UI built from
`ui/` (`rust-embed` with `allow_missing`), and `ui/dist` is not in git. So `cargo install --git` builds a collector
without the map: it serves only the "UI is not built" page. The container image (`collector/Dockerfile`) builds the
UI first and has no such gap. ADR-0007 keeps the SDKs unpublished until `v0.1.0`; it does not cover the collector.

## Decision
- The collector image is published as `ghcr.io/chepiotech/chepio-lens`, for `linux/amd64` and `linux/arm64`, only
  when a `v*` tag is pushed (`.github/workflows/image.yml`): `<version>` and, unless the version is a pre-release,
  `latest`. Each architecture is built natively on its own GitHub runner with the preinstalled Docker CLI and joined
  with `docker buildx imagetools create`; no third-party actions. Pull requests that touch the image build both
  architectures and smoke-test them without pushing.
- `collector/compose.yaml` is the way to run the image: inside the container the collector listens on `0.0.0.0`,
  the host publishes on `127.0.0.1` only (ADR-0003). The binary and the image keep their loopback defaults.
- Without Docker the collector is installed from a clone: `pnpm install --frozen-lockfile`, `pnpm --filter ui build`,
  `cargo install --path collector --locked`. `cargo install --git` is not a supported path.
- Each tag and image push is an owner decision; nothing is pushed from `main`.

## Rationale
- A prebuilt image starts in seconds and needs neither Rust nor Node on the developer's machine, which keeps the
  15-minute budget for connecting the app itself.
- Native runners avoid QEMU, which makes the Rust release build several times slower, and the CLI-only workflow adds
  no CI dependencies to approve and pin.
- Pushing only on tags keeps unreleased code out of the registry and ties every published image to a version.
- Installing from a clone keeps generated files out of git; the UI is always built from the same commit as the binary.

## Alternatives considered
- **Push from `main` on every merge**: always-fresh images, but unstable code becomes public before `v0.1.0`.
- **No registry; compose builds from the git URL**: nothing published, but the first start builds Rust and the UI
  (about 5–8 minutes), a large part of the connection budget.
- **Commit `ui/dist`** so that `cargo install --git` works: generated files in git, noisy diffs, and an embedded UI
  that can drift from its source.
- **Build the UI from `build.rs`**: needs Node, pnpm and the network during `cargo build`, fails offline, surprising
  for a Rust build.
- **Prebuilt binaries in GitHub Releases**: no Node needed, but another CI pipeline and published artifact per
  platform; reconsider if developers without Docker ask for it.
- **`docker/build-push-action` with QEMU**: one job, but slow emulated builds and four new actions to approve.

## Consequences
- Easier: one `docker compose -f collector/compose.yaml up -d` (or the service copied into a project's compose file)
  runs a collector with the map on both architectures.
- Constrained: images exist only from `v0.1.0` on; until then a clone or the demo compose builds the image locally.
  The push path of the workflow runs for the first time on the first tag.
- Installing without Docker needs Node 24 and pnpm next to Rust.
- After the first push the package's visibility in GHCR must be checked to be public.

## Validation / fitness criteria
- The image workflow passes for both architectures: `/healthz` answers, ports are published on `127.0.0.1` only, an
  OTLP batch is ingested, and the map page is served with its CSP (`collector/image-smoke.sh`).
- `cargo install --path collector --locked` from a clean clone with the UI built serves the map.

## Reconsider when
- Developers need the collector without Docker and without Node (prebuilt binaries).
- The SDKs are published (ADR-0007), so the collector's release process can be aligned with theirs.
- GitHub's arm64 runners stop being available to this repository.

## References
- `../../collector/Dockerfile`, `../../collector/compose.yaml`, `../../collector/image-smoke.sh`,
  `../../.github/workflows/image.yml`; ADR-0003, ADR-0007
