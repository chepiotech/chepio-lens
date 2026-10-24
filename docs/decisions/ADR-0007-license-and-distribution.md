# ADR-0007: Dual MIT OR Apache-2.0 license; SDKs ship as git dependencies until v0.1.0

## Status
Accepted

## Date
2026-10-23

## Context
The repository is public. The SDKs are linked into other people's apps, so their license decides whether anyone
can use chepio-lens at all. Public code without a license is "all rights reserved" and cannot legally be used.
Publishing to crates.io or npm is hard to undo (crates can only be yanked), so it should wait until the SDK API has
been tried on a real project.

## Decision
- All code in this repository (collector, `conventions`, SDKs, UI, demo) is licensed `MIT OR Apache-2.0`, at the
  user's choice. License texts: `LICENSE-MIT`, `LICENSE-APACHE` at the root. Every Cargo package sets
  `license = "MIT OR Apache-2.0"`; every npm package sets `"license": "MIT OR Apache-2.0"`.
- Until `v0.1.0` nothing is published: Cargo packages set `publish = false`, npm packages set
  `"private": true`. Projects consume the SDKs as git dependencies of this repository.
- Publishing to crates.io or npm is a separate owner decision after `v0.1.0`.

## Rationale
- `MIT OR Apache-2.0` is the convention of the Rust ecosystem, so Rust users can adopt the SDK without a legal review.
  Apache-2.0 adds an explicit patent grant; MIT stays compatible with GPL-2.0 projects.
- The project admits only permissively licensed dependencies, so no dependency conflicts with either
  license.
- Git dependencies cost nothing to set up and keep the SDK API free to change before the first real project.

## Alternatives considered
- **Apache-2.0 only**: the same freedom with one file, but incompatible with GPL-2.0-only projects.
- **Proprietary, private repository**: keeps full control, but connecting outside projects needs repository access,
  and the public design docs would have to be withdrawn.
- **Decide later**: leaves public code without a license and the Cargo/npm metadata incomplete.

## Consequences
- Easier: anyone, including commercial users, may use, modify and redistribute chepio-lens.
- Constrained: chepio.tech cannot later restrict versions already released under these terms; a future paid edition
  would have to be a separate product or a later relicensing of new code.
- Contributions are accepted under the same dual license (Apache-2.0 section 5).

## Validation / fitness criteria
- Every `Cargo.toml` and `package.json` in the workspace declares `MIT OR Apache-2.0` and `publish = false` or
  `"private": true` until `v0.1.0`.

## Reconsider when
- The first real project is connected and the SDKs are ready for crates.io and npm.
- chepio.tech plans a commercial edition built on this code.

## References
- `../../LICENSE-MIT`, `../../LICENSE-APACHE`
