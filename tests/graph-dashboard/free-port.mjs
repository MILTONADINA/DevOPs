// A port the OS reports free on 127.0.0.1, for the dashboard integration servers
// (#384). Picking one from the pid collided with ports other processes held.
import * as net from 'node:net';

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
