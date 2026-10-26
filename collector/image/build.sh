#!/bin/sh
# A static binary must retain dependency evidence: an empty package-manager scan is not sufficient.
set -eu
mkdir -p /out/evidence
rust_target=$(rustc -vV | sed -n 's/^host: //p')
case "$rust_target" in *-unknown-linux-musl) ;; *) echo "Expected a native musl builder" >&2; exit 1 ;; esac
# Select Alpine's libc/CRT, with only libunwind supplied by the pinned Rust toolchain.
export RUSTFLAGS="-C link-self-contained=no -L native=/usr/lib -L native=$(rustc --print sysroot)/lib/rustlib/$rust_target/lib/self-contained"
cargo rustc --release --locked -p chepio-lens-collector --bin chepio-lens -- -C link-arg=-Wl,-Map=/out/collector.map
cp target/release/chepio-lens /out/chepio-lens
readelf -l /out/chepio-lens > /out/program-headers
readelf -d /out/chepio-lens > /out/dynamic
if grep -q INTERP /out/program-headers || grep -q NEEDED /out/dynamic; then
    echo "Unexpected dynamic runtime dependency" >&2
    exit 1
fi
grep -q '^LOAD /usr/lib/libc.a$' /out/collector.map
if grep -q 'self-contained/libc.a' /out/collector.map; then
    echo "Untracked bundled musl selected by linker" >&2
    exit 1
fi
sha256sum /out/chepio-lens | cut -d ' ' -f 1 > /out/evidence/chepio-lens.sha256
cp Cargo.lock /out/evidence/Cargo.lock
rustc -vV > /out/evidence/rustc.txt
apk info --who-owns /usr/lib/libc.a > /out/evidence/musl-origin.txt
musl_version=$(sed -n 's|^/usr/lib/libc.a is owned by musl-dev-||p' /out/evidence/musl-origin.txt)
alpine_version=$(cat /etc/alpine-release)
test -n "$musl_version"
printf '{"bomFormat":"CycloneDX","specVersion":"1.5","version":1,"components":[{"bom-ref":"native-musl","type":"library","name":"musl","version":"%s","purl":"pkg:apk/alpine/musl@%s?distro=%s"},{"bom-ref":"alpine","type":"operating-system","name":"alpine","version":"%s","properties":[{"name":"aquasecurity:trivy:Type","value":"alpine"},{"name":"aquasecurity:trivy:Class","value":"os-pkgs"}]}],"dependencies":[{"ref":"alpine","dependsOn":["native-musl"]}]}\n' \
    "$musl_version" "$musl_version" "$alpine_version" "$alpine_version" > /out/evidence/native.cdx.json
