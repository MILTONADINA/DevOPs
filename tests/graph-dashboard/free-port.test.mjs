// #384: the dashboard integration servers get a port the OS reports free, so a port
// another process holds can no longer fail the suite with EADDRINUSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { freePort } from './free-port.mjs';

const listen = port => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});

test('freePort returns a port that is free while another port is held', async () => {
  const held = await listen(0);
  try {
    const heldPort = held.address().port;
    const port = await freePort();
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, String(port));
    assert.notEqual(port, heldPort);
    const server = await listen(port); // it really is free: binding it works
    await new Promise(resolve => server.close(resolve));
  } finally {
    await new Promise(resolve => held.close(resolve));
  }
});
