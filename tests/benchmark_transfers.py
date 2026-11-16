"""Bounded loopback benchmark; not a before/after speedup or a LAN capacity claim.
Build the API first, then: python tests/benchmark_transfers.py
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import socket
import statistics
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SIZE = 32 * 1024 * 1024
BLOCK = b'\x5a' * (1024 * 1024)
EXPECTED = hashlib.sha256(BLOCK * 32).hexdigest()


def main():
    parent = (ROOT / '.local' / 'test-runs').resolve()
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='benchmark-', dir=parent) as folder:
        storage = Path(folder).resolve()
        assert storage.is_relative_to(parent)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env = {**os.environ, 'ASPNETCORE_URLS': f'http://127.0.0.1:{port}',
               'UploadSettings__StoragePath': str(storage), 'UploadSettings__MaxFileSizeBytes': str(SIZE * 2)}
        with open(storage / 'server.log', 'w') as log:
            api = subprocess.Popen(['dotnet', str(ROOT / 'LiquidVault.Api/bin/Debug/net8.0/LiquidVault.Api.dll')],
                                   cwd=ROOT / 'LiquidVault.Api', env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        c = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
                        c.request('GET', '/health')
                        ready = c.getresponse().status == 200
                        c.close()
                        if ready:
                            break
                    except OSError:
                        time.sleep(.1)
                results = []
                # Warm up the JIT and transport without recording its throughput.
                c = http.client.HTTPConnection('127.0.0.1', port)
                c.request('POST', '/api/transfer/raw?filename=warmup.bin', b'warmup')
                warmup = json.loads(c.getresponse().read())
                c.request('DELETE', '/api/transfer/' + warmup['id']); c.getresponse().read(); c.close()
                for run in range(3):
                    c = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
                    started = time.perf_counter()
                    c.putrequest('POST', '/api/transfer/raw?filename=benchmark.bin')
                    c.putheader('Content-Type', 'application/octet-stream')
                    c.putheader('Content-Length', str(SIZE)); c.endheaders()
                    for _ in range(32): c.send(BLOCK)
                    response = c.getresponse()
                    assert response.status == 200, response.read()
                    record = json.loads(response.read())
                    uploaded = time.perf_counter() - started
                    started = time.perf_counter()
                    c.request('GET', '/api/transfer/download/' + record['id'])
                    response = c.getresponse(); assert response.status == 200
                    digest = hashlib.sha256()
                    while chunk := response.read(len(BLOCK)): digest.update(chunk)
                    downloaded = time.perf_counter() - started
                    assert digest.hexdigest() == EXPECTED
                    c.request('DELETE', '/api/transfer/' + record['id']); c.getresponse().read(); c.close()
                    results.append({'run': run + 1, 'upload_seconds': round(uploaded, 4), 'download_seconds': round(downloaded, 4),
                        'upload_MiB_per_second': round(32 / uploaded, 2), 'download_MiB_per_second': round(32 / downloaded, 2), 'sha256_verified': True})
                report = {'date': '2026-10-28', 'environment': platform.platform(), 'processor': platform.processor(),
                    'sdk_version': subprocess.check_output(['dotnet', '--version'], text=True).strip(),
                    'file_size_bytes': SIZE, 'concurrency': 1, 'runs': results,
                    'median_upload_MiB_per_second': statistics.median(r['upload_MiB_per_second'] for r in results),
                    'median_download_MiB_per_second': statistics.median(r['download_MiB_per_second'] for r in results),
                    'limitations': 'HTTP loopback, same machine/storage, repeated synthetic bytes, warm OS caches, no proxy/browser, no original-code baseline, no fsync durability or sustained load measurement. Not a LAN or 10 GB validation.'}
                output = ROOT / 'docs' / 'phase-1-benchmark.json'
                output.parent.mkdir(exist_ok=True)
                output.write_text(json.dumps(report, indent=2), encoding='utf-8')
                print(json.dumps(report, indent=2))
            finally:
                api.terminate()
                try: api.wait(timeout=10)
                except subprocess.TimeoutExpired: api.kill(); api.wait()


if __name__ == '__main__':
    main()
