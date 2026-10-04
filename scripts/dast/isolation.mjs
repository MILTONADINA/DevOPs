// One finite, pure policy for actual local DAST network and Docker observations.
import { ReportFailure, object, integer, equal, windowOf, requireValue } from './report-inputs.mjs';

const check = value => requireValue(value, 'isolation');
const PHASES = ['nuclei_before', 'nuclei_live', 'zap_before', 'zap_live', 'zap_after'];
const INERT = { tunl0: [768, 128, 4], gre0: [778, 128, 4], gretap0: [1, 4098, 6], erspan0: [1, 4098, 6],
  ip_vti0: [768, 128, 4], ip6_vti0: [769, 128, 16], sit0: [776, 128, 4], ip6tnl0: [769, 128, 16], ip6gre0: [823, 128, 16] };
const string = (value, cap) => typeof value === 'string' && Buffer.byteLength(value) <= cap;
const keys = (value, expected) => object(value) && equal(Object.keys(value).sort(), [...expected].sort());
const rows = text => text.trim() ? text.trim().split('\n').map(line => line.trim().split(/\s+/)) : [];
const empty = value => value === null || (Array.isArray(value) && value.length === 0);
function unique(values) { return new Set(values).size === values.length; }
function decimal(value) { check(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && value.trim() === value); const n = Number(value); check(integer(n)); return n; }
function hex(value) { check(typeof value === 'string' && /^(?:0x)?[0-9a-fA-F]+$/.test(value) && value.trim() === value); return BigInt(value.startsWith('0x') ? value : '0x' + value); }
function address(encoded, ipv6) {
  check(new RegExp(`^[0-9A-Fa-f]{${ipv6 ? 32 : 8}}$`).test(encoded));
  const normalized = encoded.match(/.{8}/g).map(word => word.match(/../g).reverse().join('')).join('').toLowerCase();
  if (!ipv6) return normalized.match(/../g).map(n => parseInt(n, 16)).join('.');
  if (normalized.startsWith('00000000000000000000ffff')) return normalized.slice(24).match(/../g).map(n => parseInt(n, 16)).join('.');
  return normalized;
}
function listeners(tables) {
  check(keys(tables, ['tcp', 'tcp6', 'udp', 'udp6']));
  const result = [];
  for (const family of ['tcp', 'tcp6', 'udp', 'udp6']) {
    check(string(tables[family], 262144)); const lines = rows(tables[family]);
    check(lines.length > 0 && lines[0][0] === 'sl' && lines[0][1] === 'local_address' &&
      ['rem_address', 'remote_address'].includes(lines[0][2]) && lines[0][3] === 'st');
    if (family.startsWith('udp')) { check(lines.length === 1); continue; }
    for (const row of lines.slice(1)) {
      check(row.length >= 10 && /^\d+:$/.test(row[0]) && /^[0-9A-Fa-f]{2}$/.test(row[3]) &&
        row.slice(4).every((value, i) => /^[0-9A-Fa-f]+(?::[0-9A-Fa-f]+)?$/.test(value) || (row.length === 17 && i === 12 && value === '-1')));
      const parsed = [];
      for (const cell of row.slice(1, 3)) {
        const parts = cell.split(':'); check(parts.length === 2 && /^[0-9A-Fa-f]{4}$/.test(parts[1]));
        parsed.push([address(parts[0], family === 'tcp6'), parseInt(parts[1], 16)]);
      }
      if (row[3].toUpperCase() === '0A') result.push(parsed[0]);
    }
  }
  return result.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
}
function network(n, namespace) {
  check(object(n) && n.netns === namespace && Array.isArray(n.if_nameindex) && n.if_nameindex.length >= 1 && n.if_nameindex.length <= 10);
  for (const pair of n.if_nameindex) check(Array.isArray(pair) && pair.length === 2 && integer(pair[0]) && pair[0] > 0 && typeof pair[1] === 'string');
  const names = n.if_nameindex.map(pair => pair[1]), indices = n.if_nameindex.map(pair => pair[0]);
  check(unique(names) && unique(indices) && names.includes('lo') && names.every(name => name === 'lo' || Object.hasOwn(INERT, name)));
  check(Array.isArray(n.sysfs_entries) && n.sysfs_entries.length <= 128 && n.sysfs_entries.every(x => typeof x === 'string') && unique(n.sysfs_entries));
  check(names.every(name => n.sysfs_entries.includes(name)) && Array.isArray(n.sysfs_noninterfaces));
  const extras = n.sysfs_entries.filter(name => !names.includes(name)).sort();
  check(extras.every(name => name === 'bonding_masters') && equal(extras, [...n.sysfs_noninterfaces].sort()));
  for (const key of ['ipv6_addresses_raw', 'routes4_raw', 'routes6_raw']) check(string(n[key], 65536));
  check(string(n.fib_trie_raw, 262144));
  const v6 = rows(n.ipv6_addresses_raw);
  for (const row of v6) check(row.length === 6 && row[0] === '00000000000000000000000000000001' && row[2] === '80' && row[5] === 'lo' &&
    row.slice(1, 5).every(value => /^[0-9a-fA-F]+$/.test(value)) && parseInt(row[1], 16) === n.if_nameindex.find(pair => pair[1] === 'lo')[0]);
  check(v6.length <= 1);
  check(Array.isArray(n.interfaces) && n.interfaces.length === names.length && unique(n.interfaces.map(i => i?.name)));
  for (const item of n.interfaces) {
    check(object(item) && names.includes(item.name) && item.index === n.if_nameindex.find(pair => pair[1] === item.name)[0]);
    for (const key of ['ifindex_sysfs', 'iflink_sysfs', 'flags_sysfs', 'type_sysfs', 'operstate_sysfs', 'address_sysfs']) check(string(item[key], 512));
    check(decimal(item.ifindex_sysfs) === item.index && integer(item.flags) && item.admin_up === Boolean(item.flags & 1) && item.running === Boolean(item.flags & 64));
    check(equal(item.ipv6, v6.filter(row => row[5] === item.name)));
    if (item.name === 'lo') {
      check(decimal(item.type_sysfs) === 772 && item.flags === 73 && hex(item.flags_sysfs) === 9n && decimal(item.iflink_sysfs) === item.index &&
        item.operstate_sysfs === 'unknown' && item.address_sysfs === '00:00:00:00:00:00' && item.primary_ipv4 === '127.0.0.1' && !Object.hasOwn(item, 'ipv4_absent_errno'));
    } else {
      const [type, flags, bytes] = INERT[item.name];
      check(decimal(item.type_sysfs) === type && item.flags === flags && hex(item.flags_sysfs) === BigInt(flags) && decimal(item.iflink_sysfs) === 0 &&
        item.operstate_sysfs === 'down' && !item.admin_up && !item.running && item.address_sysfs === Array(bytes).fill('00').join(':') &&
        item.primary_ipv4 === null && item.ipv4_absent_errno === 99 && item.ipv6.length === 0);
    }
  }
  const v4routes = rows(n.routes4_raw);
  check(v4routes.length === 1 && equal(v4routes[0], ['Iface', 'Destination', 'Gateway', 'Flags', 'RefCnt', 'Use', 'Metric', 'Mask', 'MTU', 'Window', 'IRTT']));
  for (const row of rows(n.routes6_raw)) {
    check(row.length === 10 && row[9] === 'lo' && /^[0-9a-fA-F]{32}$/.test(row[0]) && row[2] === '0'.repeat(32) && row[3] === '00' && row[4] === '0'.repeat(32) &&
      row.slice(5, 9).every(value => /^[0-9a-fA-F]{8}$/.test(value)));
    check((row[0] === '0'.repeat(31) + '1' && row[1] === '80' && row[8].toLowerCase() === '80200001') ||
      (row[0] === '0'.repeat(32) && row[1] === '00' && row[8].toLowerCase() === '00200200'));
  }
  const fib = n.fib_trie_raw.match(/\d+(?:\.\d+)+(?:\/\d+)?/g) || [];
  check(fib.length > 0);
  for (const value of fib) {
    const [ip, prefix] = value.split('/'), octets = ip.split('.');
    check(octets.length === 4 && octets.every(x => /^(?:0|[1-9][0-9]*)$/.test(x) && Number(x) <= 255) && octets[0] === '127' &&
      (prefix === undefined || (decimal(prefix) >= 8 && Number(prefix) <= 32)));
  }
  check(keys(n.security, ['Uid', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs']) && typeof n.security.Uid === 'string' &&
    equal(n.security.Uid.trim().split(/\s+/), ['1000', '1000', '1000', '1000']) && n.security.NoNewPrivs === '1');
  for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) check(hex(n.security[key]) === 0n);
}
function snapshot(observation, context) {
  const { kind, namespace, container_id, phase } = context;
  check(['application', 'positive_control'].includes(kind) && PHASES.includes(phase) && typeof namespace === 'string' && /^net:\[[1-9][0-9]*\]$/.test(namespace));
  check(object(observation) && observation.phase === phase && observation.container_id === container_id && observation.namespace === namespace);
  windowOf(observation, 'isolation');
  const ports = kind === 'application' ? [18080, 18081] : [18080];
  if (phase === 'nuclei_live') ports.push(18091);
  if (phase === 'zap_live') ports.push(18090);
  check(equal(listeners(observation.socket_tables), ports.map(port => ['127.0.0.1', port])));
  if (!phase.endsWith('_live')) network(observation.network, namespace);
  return { namespace, phase };
}
export function assertSnapshot(observation, context) {
  try { return snapshot(observation, context); } catch { throw new ReportFailure('isolation'); }
}
function dockerProjection(docker, context) {
  const { kind, prepared, anchor_id, zap_id } = context;
  check(['application', 'positive_control'].includes(kind) && typeof anchor_id === 'string' && /^[0-9a-f]{64}$/.test(anchor_id) &&
    typeof zap_id === 'string' && /^[0-9a-f]{64}$/.test(zap_id) && anchor_id !== zap_id && keys(docker, ['anchor', 'zap']));
  for (const role of ['anchor', 'zap']) {
    const d = docker[role], anchor = role === 'anchor', control = kind === 'positive_control';
    check(keys(d, ['id', 'image', 'config', 'host', 'mounts']) && d.id === (anchor ? anchor_id : zap_id) && d.image === prepared.images[anchor ? 'node' : 'zap'].engine_id &&
      keys(d.config, ['user']) && d.config.user === '1000:1000');
    const h = d.host;
    check(keys(h, ['network_mode', 'readonly_rootfs', 'privileged', 'cap_drop', 'cap_add', 'devices', 'device_requests', 'device_cgroup_rules', 'volumes_from',
      'security_opt', 'port_bindings', 'publish_all_ports', 'extra_hosts', 'pid_mode', 'ipc_mode', 'tmpfs']));
    check(h.network_mode === (anchor ? 'none' : 'container:' + anchor_id) && h.readonly_rootfs === anchor && h.privileged === false && equal(h.cap_drop, ['ALL']) &&
      equal(h.security_opt, ['no-new-privileges']) && (h.port_bindings === null || equal(h.port_bindings, {})) && h.publish_all_ports === false &&
      empty(h.extra_hosts) && h.pid_mode === '' && h.ipc_mode === 'private');
    for (const key of ['cap_add', 'devices', 'device_requests', 'device_cgroup_rules', 'volumes_from']) check(empty(h[key]));
    const tmpfs = { '/tmp': 'rw,nosuid,nodev,size=128m,mode=1777' };
    if (anchor && !control) tmpfs['/app/runtime/data'] = 'rw,nosuid,nodev,size=32m,mode=1777';
    check(equal(h.tmpfs, tmpfs));
    const mount = (asset, destination, read_only = true) => ({ type: 'bind', asset, destination, read_only });
    const expected = [mount('dast_scripts', '/dast'), mount('run_config', '/dast/run.json')];
    if (anchor) expected.push(...(control ? [mount('positive_control', '/control.mjs')] : [mount('app_runtime', '/app/runtime'), mount('app_observability', '/app/observability')]),
      mount('nuclei_binary', '/scanner/nuclei'), mount('laravel_env', '/scanner/laravel-env.yaml'), mount('git_config', '/scanner/git-config.yaml'),
      mount('nuclei_ignore', '/scanner/default-ignore.yaml'), mount('reports', '/out', false));
    else expected.push(mount('zap_common', '/zap/zap_common.py'), mount('reports', '/zap/wrk', false));
    check(Array.isArray(d.mounts) && d.mounts.every(m => object(m) && typeof m.destination === 'string'));
    const order = (a, b) => a.destination.localeCompare(b.destination);
    check(equal([...d.mounts].sort(order), expected.sort(order)));
  }
}
export function assertDockerProjection(docker, context) {
  try { dockerProjection(docker, context); return { anchor_id: context.anchor_id, zap_id: context.zap_id }; }
  catch { throw new ReportFailure('isolation'); }
}
export function assertIsolation(record, context) {
  try {
    check(object(record) && record.schema_version === 1 && record.run_id === context.run_id && record.kind === context.kind &&
      record.prepared_sha256 === context.prepared_sha256 && record.anchor_id === context.anchor_id);
    assertDockerProjection(record.docker, context);
    check(Array.isArray(record.observations) && record.observations.length === PHASES.length);
    const runWindow = windowOf(context, 'isolation'), nuclei = windowOf(context.stages.nuclei, 'isolation'), zap = windowOf(context.stages.zap, 'isolation');
    const windows = record.observations.map((observation, i) => {
      assertSnapshot(observation, { kind: context.kind, namespace: record.namespace, container_id: i === 1 ? context.anchor_id : context.zap_id, phase: PHASES[i] });
      const w = windowOf(observation, 'isolation'); check(w[0] >= runWindow[0] && w[1] <= runWindow[1]); return w;
    });
    check(windows[0][1] <= nuclei[0] && windows[1][0] >= nuclei[0] && windows[1][1] <= nuclei[1] &&
      windows[2][0] >= nuclei[1] && windows[2][1] <= zap[0] && windows[3][0] >= zap[0] && windows[3][1] <= zap[1] && windows[4][0] >= zap[1]);
    return { namespace: record.namespace, phases: [...PHASES] };
  } catch { throw new ReportFailure('isolation'); }
}
