# ADR-0017: A static musl collector in a scratch runtime with dependency evidence

## Status
Accepted

## Date
2026-10-26

## Context
The real-project integration scans every runtime dependency. The collector's Debian image includes tools and
libraries that it never uses, and fails that project's vulnerability gate. A package-free image alone would hide
statically linked native dependencies from ordinary filesystem scanners rather than establish their safety.

## Decision
Build the collector natively on the official Rust Alpine image and link its versioned system musl/CRT. The owner
approved musl (MIT). Use scratch for the runtime, retaining the existing non-root user, listener defaults and embedded
UI. The Rust compiler supplies libunwind; its exact version and target are recorded. No application dependency changes.

Keep the binary hash, source Cargo.lock, compiler metadata, musl package origin and CycloneDX native inventory in
`/usr/share/chepio-lens-build/`. Include musl's complete copyright/license notice. Verify that the link map selects
system libc and that the actual binary has no interpreter or shared-library dependency. Native amd64/arm64 image CI
checks the exported filesystem, evidence, loopback publication, OTLP ingest and embedded UI before any publication.

## Rationale
The collector receives data and serves embedded assets; it needs no shell, package manager, outbound TLS roots or
operating-system utilities. Static linking allows those packages to be removed. Preserved native evidence allows
the remaining libc to be checked against its actual Alpine package identity instead of treating an empty image scan
as proof of no vulnerabilities.

## Alternatives considered
- Update Debian packages: retain unused runtime components and advisories without an available vendor fix.
- Copy only glibc and its loader: smaller image, but still requires tracking and updating glibc and its runtime files.
- Use the Rust toolchain's bundled musl: simpler build, but its version is not tied to an installed, scannable package.
- Ignore base-image findings: conflicts with the receiving project's security gate.

## Consequences
The runtime has no shell; inspect it through Docker export/cp and use the HTTP health endpoint. Changes to musl need
a rebuild and repeat scan. Application code, distribution triggers and owner approval for tags/image publication
remain governed by ADR-0011. This decision does not add a scanner dependency to collector CI; consumers scan the
image, recorded native inventory and Cargo.lock with their approved tools.

## Validation / fitness criteria
- `collector/image/build.sh` rejects dynamic dependencies and an unrecorded bundled libc.
- `python3 -B -m unittest discover -s collector/image -p '*_test.py'` tests rejection of dynamic code, extra runtime
  files, missing or stale evidence and wrong architecture.
- `python3 collector/image/verify.py IMAGE` and `collector/image-smoke.sh IMAGE` pass for amd64 and arm64.
- Native inventory and Rust dependency scans remain required in the real project; scanning scratch alone is insufficient.

## Reconsider when
The collector gains outbound TLS, native dependencies beyond the recorded runtime, or unsupported static-link behavior.

## References
- [Rust link-self-contained option](https://doc.rust-lang.org/rustc/codegen-options/index.html#link-self-contained)
- [musl 1.2.6 copyright and license](https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT?h=v1.2.6)
- ADR-0011; `../../collector/image/`; `../../.github/workflows/image.yml`
