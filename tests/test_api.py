"""Phase 1 integration regressions. Build the API, then run: python tests/test_api.py.

Uses only Python's standard library. Starts its own API on an ephemeral loopback
port with bounded limits and isolated temporary storage; never reads real uploads.
"""
import concurrent.futures
import http.client
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class TransferTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        test_root = (ROOT / '.local' / 'test-runs').resolve()
        test_root.mkdir(parents=True, exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix='phase1-', dir=test_root)
        cls.storage = Path(cls.temp.name).resolve()
        assert cls.storage.is_relative_to(test_root)  # Restrict recursive test cleanup to its own workspace subtree.
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        cls.base = f'http://127.0.0.1:{cls.port}'
        cls.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        env = {**os.environ, 'ASPNETCORE_URLS': cls.base, 'ASPNETCORE_ENVIRONMENT': 'Production',
               'UploadSettings__StoragePath': str(cls.storage), 'UploadSettings__MaxFileSizeBytes': '1048576',
               'UploadSettings__MaxBatchFiles': '3', 'UploadSettings__MaxTextBytes': '64',
               'UploadSettings__CleanupIntervalSeconds': '1'}
        cls.log = open(cls.storage / 'server.log', 'w', encoding='utf-8')
        cls.api = subprocess.Popen(['dotnet', str(ROOT / 'LiquidVault.Api/bin/Debug/net8.0/LiquidVault.Api.dll')],
                                   cwd=ROOT / 'LiquidVault.Api', env=env, stdout=cls.log, stderr=cls.log)
        for _ in range(100):
            try:
                if cls.call('/health')[0] == 200:
                    return
            except (OSError, urllib.error.URLError):
                pass
            if cls.api.poll() is not None:
                break
            time.sleep(.1)
        cls.tearDownClass()
        raise RuntimeError('Test API failed to start. Build the backend first.')

    @classmethod
    def tearDownClass(cls):
        cls.api.terminate()
        try:
            cls.api.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.api.kill()
            cls.api.wait()
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def call(cls, path, data=None, method='GET', headers=None):
        try:
            with cls.opener.open(urllib.request.Request(cls.base + path, data=data, method=method,
                                                      headers=headers or {}), timeout=10) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers

    def setUp(self):
        self.ids = []

    def tearDown(self):
        for identifier in self.ids:
            self.call('/api/transfer/' + identifier, method='DELETE')

    def raw(self, payload=b'0123456789', filename='sample.txt'):
        from urllib.parse import urlencode
        status, body, _ = self.call('/api/transfer/raw?' + urlencode({'filename': filename}), payload, 'POST',
                                    {'Content-Type': 'application/octet-stream'})
        if status == 200:
            record = json.loads(body)
            self.ids.append(record['id'])
            return record
        return status

    def multipart(self, files, batch=True, retention=False):
        boundary = 'PhaseOneBoundary'
        body = b''
        for name, value in files:
            body += (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{name}"\r\n'
                     'Content-Type: application/octet-stream\r\n\r\n').encode() + value + b'\r\n'
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="keepForever"\r\n\r\n'
                 f'{str(retention).lower()}\r\n--{boundary}--\r\n').encode()
        status, content, _ = self.call('/api/transfer/' + ('batch' if batch else 'upload'), body, 'POST',
                                        {'Content-Type': 'multipart/form-data; boundary=' + boundary})
        if status == 200:
            record = json.loads(content)
            self.ids.append(record['id'])
            return record
        return status

    def test_raw_roundtrip_and_range(self):
        record = self.raw()
        self.assertEqual(len(record['id']), 64)
        status, data, headers = self.call('/api/transfer/download/' + record['id'])
        self.assertEqual((status, data), (200, b'0123456789'))
        self.assertIn('attachment', headers['Content-Disposition'])
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        status, data, headers = self.call('/api/transfer/download/' + record['id'], headers={'Range': 'bytes=2-5'})
        self.assertEqual((status, data), (206, b'2345'))
        self.assertEqual(headers['Content-Range'], 'bytes 2-5/10')

    def test_head_and_invalid_range(self):
        record = self.raw()
        path = '/api/transfer/download/' + record['id']
        status, data, headers = self.call(path, method='HEAD')
        self.assertEqual((status, data, headers['Content-Length']), (200, b'', '10'))
        self.assertEqual(self.call(path, headers={'Range': 'bytes=100-200'})[0], 416)

    def test_multipart_compatibility_and_retention(self):
        record = self.multipart([('original.txt', b'hello')], batch=False, retention=True)
        self.assertEqual(record['filename'], 'original.txt')
        self.assertTrue(record['expiresAt'].startswith('9999'))
        self.assertEqual(self.call('/api/transfer/download/' + record['id'])[1], b'hello')

    def test_zip_duplicate_names_and_content(self):
        record = self.multipart([('same.txt', b'one'), ('same.txt', b'two')])
        data = self.call('/api/transfer/download/' + record['id'])[1]
        archive = zipfile.ZipFile(io.BytesIO(data))
        self.assertEqual(archive.read('same.txt'), b'one')
        self.assertEqual(archive.read('same (2).txt'), b'two')
        self.assertTrue(all(entry.compress_type == zipfile.ZIP_STORED for entry in archive.infolist()))

    def test_limits_and_partial_rollback(self):
        self.assertEqual(self.raw(b''), 400)
        self.assertEqual(self.raw(b'x' * 1048577), 413)
        self.assertEqual(self.multipart([('large.bin', b'x' * 1048577)]), 413)
        self.assertEqual(self.multipart([('a', b'x')] * 4), 400)
        self.assertEqual(self.multipart([('a', b'')]), 400)
        self.assertEqual(self.multipart([('a', b'x' * 600000), ('b', b'x' * 600000)]), 413)
        self.assertEqual(list(self.storage.glob('*.partial')), [])
        self.assertEqual(list(self.storage.glob('*.pending')), [])

    def test_safe_names(self):
        for name in ['../bad', '..\\bad', 'C:bad', '.', 'bad\nname', 'x' * 181]:
            self.assertEqual(self.raw(filename=name), 400)
        self.assertEqual(self.multipart([('../unsafe.txt', b'payload')]), 400)

    def test_traversal_and_poisoned_metadata(self):
        sentinel = self.storage.parent / (self.storage.name + '-sentinel')
        sentinel.write_text('keep')
        try:
            for path in ['..%5C' + sentinel.name, '..%2F' + sentinel.name, '%2Fabsolute', 'xyz']:
                self.assertIn(self.call('/api/transfer/' + path, method='DELETE')[0], [400, 404])
            bad_id = 'a' * 64
            (self.storage / (bad_id + '.meta.json')).write_text(json.dumps({
                'Id': '..\\' + sentinel.name, 'Filename': 'bad.txt', 'Type': 'file', 'Size': 4,
                'ExpiresAt': '2000-01-01T00:00:00Z'}))
            self.assertEqual(self.call('/api/transfer')[0], 200)
            time.sleep(1.3)
            self.assertEqual(sentinel.read_text(), 'keep')
        finally:
            sentinel.unlink(missing_ok=True)
            (self.storage / ('a' * 64 + '.meta.json')).unlink(missing_ok=True)

    def test_corrupt_metadata_does_not_block_cleanup(self):
        bad = self.storage / ('0' * 64 + '.meta.json')
        bad.write_text('{invalid')
        record = self.raw()
        metadata = self.storage / (record['id'] + '.meta.json')
        data = json.loads(metadata.read_text())
        data['ExpiresAt'] = '2000-01-01T00:00:00Z'
        metadata.write_text(json.dumps(data))
        try:
            self.assertEqual(self.call('/api/transfer')[0], 200)
            self.assertEqual(self.call('/api/transfer/download/' + record['id'])[0], 404)
            time.sleep(1.3)
            self.assertFalse(metadata.exists())
            self.assertFalse((self.storage / record['id']).exists())
        finally:
            bad.unlink(missing_ok=True)

    def test_text_validation_and_utf8(self):
        for payload, expected in [({'text': ''}, 400), ({'text': 'x' * 65}, 413),
                                   ({'title': '../bad', 'text': 'hello'}, 400), ({'text': 'नमस्ते'}, 200)]:
            status, body, _ = self.call('/api/transfer/text', json.dumps(payload).encode(), 'POST', {'Content-Type': 'application/json'})
            self.assertEqual(status, expected)
            if status == 200:
                record = json.loads(body)
                self.ids.append(record['id'])
                self.assertEqual(self.call('/api/transfer/download/' + record['id'])[1].decode(), payload['text'])

    def test_legacy_metadata_and_idempotent_delete(self):
        identifier = '1234abcd'
        self.ids.append(identifier)
        (self.storage / identifier).write_bytes(b'legacy')
        (self.storage / (identifier + '.meta.json')).write_text(json.dumps({
            'Id': identifier, 'Filename': 'legacy.txt', 'Type': 'file', 'Size': 6,
            'ExpiresAt': '9999-12-31T23:59:59'}))
        self.assertEqual(self.call('/api/transfer/download/' + identifier)[1], b'legacy')
        self.assertIn(identifier, [r['id'] for r in json.loads(self.call('/api/transfer')[1])])
        for _ in range(2):
            self.assertEqual(self.call('/api/transfer/' + identifier, method='DELETE')[0], 204)

    def test_cross_origin_mutation_and_list_bound(self):
        self.assertEqual(self.call('/api/transfer/text', b'{"text":"hello"}', 'POST',
            {'Origin': 'https://unrelated.example', 'Content-Type': 'application/json'})[0], 403)
        self.assertEqual(self.call('/api/transfer?limit=201')[0], 400)
        settings = json.loads(self.call('/api/transfer/settings')[1])
        self.assertEqual(settings['maxFileSizeBytes'], 1048576)

    def test_parallel_uploads_are_distinct(self):
        def send(index):
            return self.raw(f'content-{index}'.encode(), f'{index}.txt')
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            records = list(pool.map(send, range(8)))
        self.assertEqual(len({r['id'] for r in records}), 8)
        for index, record in enumerate(records):
            self.assertEqual(self.call('/api/transfer/download/' + record['id'])[1], f'content-{index}'.encode())

    def test_interrupted_raw_upload_reclaims_partial(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.port)
        connection.putrequest('POST', '/api/transfer/raw?filename=interrupted.bin')
        connection.putheader('Content-Length', '1000000')
        connection.endheaders()
        connection.send(b'x' * 10000)
        time.sleep(.1)
        connection.close()
        for _ in range(30):
            if not list(self.storage.glob('*.partial')):
                break
            time.sleep(.1)
        self.assertEqual(list(self.storage.glob('*.partial')), [])
        self.assertFalse(any(item['filename'] == 'interrupted.bin' for item in json.loads(self.call('/api/transfer')[1])))


if __name__ == '__main__':
    unittest.main(verbosity=2)
