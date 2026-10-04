"""Fixed traditional-baseline callbacks. See specs/security/local-dast.md."""
import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import time
from urllib.parse import urlsplit

OUT = Path('/zap/wrk')
ORIGIN = 'http://127.0.0.1:18080'
SEED = ORIGIN + '/docs'
RECEIPT_CAP = 262144
REPORT_CAP = 10 * 1024 * 1024
NATIVE_IGNORED = ['-1', '50003', '60000', '60001']

# These two fixed inputs are prepared, verified and mounted readonly by the
# runner. The pinned ModuleType loader does not initialize __file__.
config_bytes = Path('/dast/run.json').read_bytes()
assert len(config_bytes) <= 1024, 'Invalid fixed run identity'
CONFIG = json.loads(config_bytes.decode('utf-8', 'strict'))
assert type(CONFIG) is dict and set(CONFIG) == {
    'schema_version', 'run_id', 'kind', 'prepared_sha256'
}, 'Invalid fixed run identity'
assert type(CONFIG['schema_version']) is int and CONFIG['schema_version'] == 1
assert type(CONFIG['run_id']) is str and re.fullmatch(r'mr21-dast-[0-9a-f]{32}', CONFIG['run_id'])
assert CONFIG['kind'] in ('application', 'positive_control')
assert type(CONFIG['prepared_sha256']) is str and re.fullmatch(r'[0-9a-f]{64}', CONFIG['prepared_sha256'])
source_bytes = Path('/dast/zap-completion.py').read_bytes()
assert len(source_bytes) <= RECEIPT_CAP, 'Invalid fixed hook source'
STATE = {'schema_version': 1, 'run_id': CONFIG['run_id'], 'seed': SEED,
         'hook_sha256': hashlib.sha256(source_bytes).hexdigest(), 'events': []}


def event(name, **values):
    expected = ['started', 'spider_entered', 'spider_returned', 'before_report', 'before_shutdown']
    index = len(STATE['events'])
    assert index < len(expected) and expected[index] == name, 'Invalid callback order'
    tick = time.monotonic_ns()
    assert tick >= 0 and (not index or tick > int(STATE['events'][-1]['monotonic_ns']))
    item = {'event': name, 'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'monotonic_ns': str(tick), **values}
    STATE['events'].append(item)
    return item


def emit(name, value):
    assert name in ('zap-before-report.json', 'zap-completion.json')
    raw = (json.dumps(value, ensure_ascii=True, separators=(',', ':')) + '\n').encode()
    assert len(raw) <= RECEIPT_CAP, 'Completion receipt exceeds bound'
    with (OUT / name).open('xb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())


def scoped(url):
    assert type(url) is str and len(url) <= 8192, 'Invalid scoped URL'
    assert not any(ord(char) <= 32 or ord(char) == 127 for char in url) and '\\' not in url
    value = urlsplit(url)
    assert value.scheme == 'http' and value.netloc == '127.0.0.1:18080', 'Foreign scoped URL'
    assert not value.fragment and not value.username and not value.password


def read_report():
    """Read only the existing owned regular report, without following redirects."""
    file = OUT / 'zap.json'
    for parent in reversed(file.absolute().parents):
        assert stat.S_ISDIR(parent.lstat().st_mode), 'Redirected report parent'
    before = file.lstat()  # Missing report deliberately remains FileNotFoundError.
    assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1
    assert 0 < before.st_size <= REPORT_CAP, 'Invalid report size'
    identity = lambda item: (item.st_dev, item.st_ino, item.st_size,
                             item.st_mtime_ns, item.st_ctime_ns, item.st_nlink)
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        assert stat.S_ISREG(opened.st_mode) and identity(opened) == identity(before)
        chunks = []
        total = 0
        while True:
            part = os.read(fd, min(65536, REPORT_CAP + 1 - total))
            if not part:
                break
            chunks.append(part)
            total += len(part)
            assert total <= REPORT_CAP, 'Report exceeds bound'
        assert total == before.st_size
        assert identity(os.fstat(fd)) == identity(before) == identity(file.lstat())
        return b''.join(chunks)
    finally:
        os.close(fd)


def zap_started(zap, target):
    assert target == SEED and zap.core.version == '2.17.0'
    listeners = []
    tables = {}
    for family in ('tcp', 'tcp6', 'udp', 'udp6'):
        raw = Path('/proc/net/' + family).read_bytes()
        assert len(raw) <= RECEIPT_CAP, 'Socket observation exceeds bound'
        tables[family] = raw.decode('utf-8', 'strict')
        lines = tables[family].splitlines()
        assert lines and 'local_address' in lines[0], 'Missing socket header'
        rows = lines[1:]
        if family.startswith('udp'):
            assert not rows, 'Unexpected UDP socket'
            continue
        for row in rows:
            fields = row.split()
            assert len(fields) >= 10 and re.fullmatch(r'[0-9A-Fa-f]{2}', fields[3])
            if fields[3].upper() != '0A':
                continue
            address, port = fields[1].split(':')
            assert re.fullmatch(r'[0-9A-Fa-f]{4}', port)
            assert re.fullmatch(r'[0-9A-Fa-f]{' + ('32' if family == 'tcp6' else '8') + '}', address)
            packed = bytes.fromhex(address)
            packed = b''.join(packed[i:i + 4][::-1] for i in range(0, len(packed), 4))
            ip = ipaddress.ip_address(packed)
            if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
                ip = ip.ipv4_mapped
            listeners.append((str(ip), int(port, 16)))
    ports = {18080, 18090} | ({18081} if CONFIG['kind'] == 'application' else set())
    assert len(listeners) == len(ports) and set(listeners) == {('127.0.0.1', port) for port in ports}
    namespace = os.readlink('/proc/self/ns/net')
    assert re.fullmatch(r'net:\[[1-9][0-9]*\]', namespace)
    event('started', listeners=listeners, socket_tables=tables, namespace=namespace)
    return zap, target


def zap_spider(zap, target):
    assert target == ORIGIN + '/'
    event('spider_entered', target=target)
    return zap, target


def zap_spider_wrap(result):
    assert result is None
    event('spider_returned')
    return result


def zap_get_alerts(zap, baseurl, ignore_scan_rules, out_of_scope_dict):
    assert baseurl == ORIGIN + '/'
    assert ignore_scan_rules == NATIVE_IGNORED and type(out_of_scope_dict) is dict and not out_of_scope_dict
    assert zap.pscan.records_to_scan == '0', 'Passive queue is unfinished before report'
    event('before_report', queue='0')
    emit('zap-before-report.json', STATE)
    return zap, baseurl, ignore_scan_rules, out_of_scope_dict


def zap_pre_shutdown(zap):
    assert len(STATE['events']) == 4 and STATE['events'][-1]['event'] == 'before_report'
    assert zap.pscan.records_to_scan == '0', 'Passive queue is unfinished at shutdown'
    urls = zap.core.urls()
    assert type(urls) is list and 1 <= len(urls) <= 4096 and SEED in urls
    for url in urls:
        scoped(url)
    rules = zap.pscan.scanners
    assert type(rules) is list and 1 <= len(rules) <= 512
    assert all(type(rule) is dict for rule in rules)
    assert any(rule.get('id') == '10062' and rule.get('enabled') == 'true' for rule in rules)
    report = read_report()
    event('before_shutdown', queue='0')
    emit('zap-completion.json', {**STATE, 'urls': urls, 'rules': rules,
                                'report_sha256': hashlib.sha256(report).hexdigest(),
                                'report_bytes': len(report)})
