# Core
import hashlib
import json
import struct
import unittest
# Utils
from verify import BINARY, EVIDENCE, LICENSE, ROOT, check_elf, check_files


def binary(kind=1, architecture=183):
    value = bytearray(136)
    value[:6] = b'\x7fELF\x02\x01'
    struct.pack_into('<H', value, 18, architecture)
    struct.pack_into('<Q', value, 32, 64)
    struct.pack_into('<HH', value, 54, 56, 1)
    struct.pack_into('<I', value, 64, kind)
    return value


def fixture():
    code = binary()
    return {
        BINARY: code,
        LICENSE: (ROOT / 'collector/image/musl-COPYRIGHT').read_bytes(),
        EVIDENCE + 'Cargo.lock': b'locked dependencies',
        EVIDENCE + 'chepio-lens.sha256': hashlib.sha256(code).hexdigest().encode(),
        EVIDENCE + 'rustc.txt': b'host: aarch64-unknown-linux-musl\n',
        EVIDENCE + 'musl-origin.txt': b'/usr/lib/libc.a is owned by musl-dev-1.2.6-r3\n',
        EVIDENCE + 'native.cdx.json': json.dumps({'components': [{
            'type': 'library', 'name': 'musl', 'version': '1.2.6-r3',
            'purl': 'pkg:apk/alpine/musl@1.2.6-r3?distro=3.24.1',
        }]}).encode(),
    }


class ImageVerificationTests(unittest.TestCase):
    def test_accepts_static_elf_for_both_native_architectures(self):
        check_elf(binary(), 'arm64')
        check_elf(binary(architecture=62), 'amd64')
        check_files(fixture(), 'arm64', b'locked dependencies')

    def test_rejects_interpreter_and_shared_library(self):
        with self.assertRaisesRegex(ValueError, 'interpreter'):
            check_elf(binary(kind=3), 'arm64')
        code = binary(kind=2)
        struct.pack_into('<Q', code, 72, 120)
        struct.pack_into('<Q', code, 96, 16)
        struct.pack_into('<q', code, 120, 1)
        with self.assertRaisesRegex(ValueError, 'shared library'):
            check_elf(code, 'arm64')

    def test_rejects_wrong_architecture_and_truncated_headers(self):
        for code, architecture in [(binary(), 'amd64'), (binary()[:80], 'arm64'), (b'not ELF', 'arm64')]:
            with self.subTest(architecture=architecture, length=len(code)), self.assertRaises(ValueError):
                check_elf(code, architecture)

    def test_rejects_extra_runtime_and_missing_evidence(self):
        for change in ['shell', 'missing']:
            files = fixture()
            if change == 'shell':
                files['bin/sh'] = b'not permitted'
            else:
                del files[EVIDENCE + 'native.cdx.json']
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'files'):
                check_files(files, 'arm64', b'locked dependencies')

    def test_rejects_stale_or_tampered_build_evidence(self):
        for name in ['chepio-lens.sha256', 'Cargo.lock', 'musl-origin.txt', 'rustc.txt']:
            files = fixture()
            files[EVIDENCE + name] = b'stale'
            with self.subTest(name=name), self.assertRaises(ValueError):
                check_files(files, 'arm64', b'locked dependencies')

    def test_rejects_missing_native_identity_and_changed_license(self):
        for name, value in [(EVIDENCE + 'native.cdx.json', b'{"components": []}'), (LICENSE, b'changed')]:
            files = fixture()
            files[name] = value
            with self.subTest(name=name), self.assertRaises(ValueError):
                check_files(files, 'arm64', b'locked dependencies')
