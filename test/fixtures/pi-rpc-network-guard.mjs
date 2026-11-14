// Defense in depth for the trusted installed-CLI probe, NOT an OS sandbox.
import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

function blocked() {
  fs.appendFileSync(process.env.PIS_RPC_NETWORK_REPORT, 'blocked\n');
  throw new Error('Network disabled by local RPC compatibility probe');
}
net.Socket.prototype.connect = blocked;
net.connect = blocked;
net.createConnection = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
