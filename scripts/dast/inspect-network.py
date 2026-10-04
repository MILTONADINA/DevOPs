#!/usr/bin/env python3
"""Collect bounded native facts; the shared JS validator decides isolation."""
import datetime
import errno
import fcntl
import json
import os
import re
import socket
import stat
import struct
import sys


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def bounded(file, cap=65536):
    # Fixed proc/sysfs paths include kernel-managed parent symlinks. No caller
    # supplies a path, and the final file must be regular and read without follow.
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('Nonregular observation')
        parts = []
        total = 0
        while True:
            part = os.read(fd, min(65536, cap + 1 - total))
            if not part:
                break
            parts.append(part)
            total += len(part)
            if total > cap:
                raise ValueError('Observation exceeds bound')
        return b''.join(parts).decode('utf-8', 'strict')
    finally:
        os.close(fd)


def collect():
    started = now()
    namespace = os.readlink('/proc/self/ns/net')
    if not re.fullmatch(r'net:\[[1-9][0-9]*\]', namespace):
        raise ValueError('Invalid namespace identity')
    identities = socket.if_nameindex()
    if not 1 <= len(identities) <= 10:
        raise ValueError('Interface count exceeds bound')
    if len({index for index, _ in identities}) != len(identities) or len({name for _, name in identities}) != len(identities):
        raise ValueError('Duplicate interface identity')
    for index, name in identities:
        if index <= 0 or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', name) or name in ('.', '..'):
            raise ValueError('Invalid interface identity')
    entries = []
    with os.scandir('/sys/class/net') as iterator:
        for entry in iterator:
            entries.append(entry.name)
            if len(entries) > 128:
                raise ValueError('Sysfs count exceeds bound')
    entries.sort()
    v6 = bounded('/proc/net/if_inet6')
    rows6 = [line.split() for line in v6.splitlines()]
    if any(len(row) != 6 for row in rows6):
        raise ValueError('Invalid IPv6 framing')
    network = {'netns': namespace, 'if_nameindex': identities,
               'sysfs_entries': entries,
               'sysfs_noninterfaces': sorted(set(entries) - {name for _, name in identities}),
               'ipv6_addresses_raw': v6, 'interfaces': []}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
        for index, name in identities:
            request = struct.pack('256s', name.encode('ascii'))
            flags = struct.unpack_from('H', fcntl.ioctl(control.fileno(), 0x8913, request), 16)[0]
            row = {'index': index, 'name': name, 'flags': flags,
                   'admin_up': bool(flags & 1), 'running': bool(flags & 0x40)}
            for field in ('ifindex', 'iflink', 'flags', 'type', 'operstate', 'address'):
                row[field + '_sysfs'] = bounded('/sys/class/net/' + name + '/' + field, 512).strip()
            try:
                address = fcntl.ioctl(control.fileno(), 0x8915, request)
                row['primary_ipv4'] = socket.inet_ntop(socket.AF_INET, address[20:24])
            except OSError as error:
                if error.errno != errno.EADDRNOTAVAIL:
                    raise
                row['primary_ipv4'] = None
                row['ipv4_absent_errno'] = error.errno
            row['ipv6'] = [row6 for row6 in rows6 if row6[5] == name]
            network['interfaces'].append(row)
    network['routes4_raw'] = bounded('/proc/net/route')
    network['routes6_raw'] = bounded('/proc/net/ipv6_route')
    network['fib_trie_raw'] = bounded('/proc/net/fib_trie', 262144)
    status = {}
    for line in bounded('/proc/self/status').splitlines():
        if ':' in line:
            key, value = line.split(':', 1)
            if key in status:
                raise ValueError('Duplicate process status')
            status[key] = value.strip()
    network['security'] = {key: status[key] for key in (
        'Uid', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs')}
    tables = {family: bounded('/proc/net/' + family, 262144)
              for family in ('tcp', 'tcp6', 'udp', 'udp6')}
    if os.readlink('/proc/self/ns/net') != namespace:
        raise ValueError('Namespace changed during observation')
    return {'started_at': started, 'finished_at': now(), 'namespace': namespace,
            'network': network, 'socket_tables': tables}


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError('Unexpected arguments')
        raw = (json.dumps(collect(), ensure_ascii=True, separators=(',', ':')) + '\n').encode()
        if len(raw) > 262144:
            raise ValueError('Observation output exceeds bound')
    except Exception:
        sys.stderr.write('dast-network: unavailable\n')
        return 1
    sys.stdout.buffer.write(raw)
    return 0


if __name__ == '__main__':
    sys.exit(main())
