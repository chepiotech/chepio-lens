#!/usr/bin/env python3
"""Check the actual image filesystem and its static dependency evidence without running a shell inside it."""
# Core
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
BINARY = 'usr/local/bin/chepio-lens'
EVIDENCE = 'usr/share/chepio-lens-build/'
LICENSE = 'usr/share/licenses/musl/COPYRIGHT'
REQUIRED = {BINARY, LICENSE} | {EVIDENCE + name for name in [
    'Cargo.lock', 'chepio-lens.sha256', 'rustc.txt', 'musl-origin.txt', 'native.cdx.json',
]}
# Docker adds these to a container even when its image is scratch.
DOCKER_FILES = {'.dockerenv', 'etc/hosts', 'etc/hostname', 'etc/resolv.conf'}


def check_elf(binary, architecture):
    if len(binary) < 64 or binary[:6] != b'\x7fELF\x02\x01':
        raise ValueError('Expected a little-endian ELF64 binary')
    if struct.unpack_from('<H', binary, 18)[0] != {'amd64': 62, 'arm64': 183}[architecture]:
        raise ValueError('ELF architecture does not match the image')
    offset = struct.unpack_from('<Q', binary, 32)[0]
    size, count = struct.unpack_from('<HH', binary, 54)
    if size < 56 or not count or offset + size * count > len(binary):
        raise ValueError('Invalid ELF program headers')
    for index in range(count):
        header = offset + index * size
        kind = struct.unpack_from('<I', binary, header)[0]
        if kind == 3:  # PT_INTERP: a dynamic runtime loader.
            raise ValueError('ELF requires a runtime interpreter')
        if kind == 2:  # PT_DYNAMIC: even a static PIE may have a dynamic section.
            start = struct.unpack_from('<Q', binary, header + 8)[0]
            length = struct.unpack_from('<Q', binary, header + 32)[0]
            if length % 16 or start + length > len(binary):
                raise ValueError('Invalid ELF dynamic section')
            for entry in range(start, start + length, 16):
                tag = struct.unpack_from('<q', binary, entry)[0]
                if tag == 0:
                    break
                if tag == 1:  # DT_NEEDED.
                    raise ValueError('ELF requires a shared library')


def check_files(files, architecture, expected_lock):
    if not REQUIRED <= files.keys() or files.keys() - REQUIRED - DOCKER_FILES:
        raise ValueError('Runtime contains missing or unexpected files')
    binary = files[BINARY]
    check_elf(binary, architecture)
    if files[EVIDENCE + 'chepio-lens.sha256'].decode().strip() != hashlib.sha256(binary).hexdigest():
        raise ValueError('Binary hash differs from build evidence')
    if files[EVIDENCE + 'Cargo.lock'] != expected_lock:
        raise ValueError('Runtime dependency lock differs from source')
    inventory = json.loads(files[EVIDENCE + 'native.cdx.json'])
    libraries = [item for item in inventory['components'] if item['type'] != 'operating-system']
    if len(libraries) != 1 or libraries[0]['name'] != 'musl':
        raise ValueError('Missing native musl inventory')
    musl = libraries[0]
    version = musl['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+-r\d+', version):
        raise ValueError('Invalid musl package version')
    if not re.fullmatch(r'pkg:apk/alpine/musl@' + re.escape(version) + r'\?distro=\d+\.\d+\.\d+', musl['purl']):
        raise ValueError('Invalid musl package origin')
    if files[EVIDENCE + 'musl-origin.txt'].decode().strip() != '/usr/lib/libc.a is owned by musl-dev-' + version:
        raise ValueError('Musl inventory differs from the build origin')
    target = {'amd64': 'x86_64', 'arm64': 'aarch64'}[architecture] + '-unknown-linux-musl'
    if ('host: ' + target + '\n').encode() not in files[EVIDENCE + 'rustc.txt']:
        raise ValueError('Missing native compiler evidence')
    if files[LICENSE] != (ROOT / 'collector/image/musl-COPYRIGHT').read_bytes():
        raise ValueError('Musl license differs from source')


def verify(image):
    config = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image]))[0]
    if config['Config']['User'] != '65534:65534':
        raise ValueError('Collector must run as the existing non-root user')
    container = subprocess.check_output(['docker', 'create', image]).decode().strip()
    try:
        with tempfile.TemporaryDirectory(prefix='lens-image-check-') as directory:
            archive = Path(directory) / 'rootfs.tar'
            subprocess.run(['docker', 'export', '-o', str(archive), container], check=True)
            files = {}
            with tarfile.open(archive) as rootfs:
                for member in rootfs:
                    if member.isdir():
                        continue
                    if not member.isfile() or member.name in files:
                        raise ValueError('Unexpected runtime filesystem entry')
                    files[member.name] = rootfs.extractfile(member).read()
            check_files(files, config['Architecture'], (ROOT / 'Cargo.lock').read_bytes())
    finally:
        subprocess.run(['docker', 'rm', container], check=True, stdout=subprocess.DEVNULL)
    print('Static runtime, native dependency evidence, license and non-root user verified.')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: verify.py IMAGE')
    verify(sys.argv[1])
