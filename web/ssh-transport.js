import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { serverAddress } from './server-address.js';

// A private Unix listener avoids TCP port collisions and lets the HTTP Host and
// WS URL remain the server's exact loopback origin. No Host/Origin bypass needed.
export async function openServerTransport(
  address,
  { signal, spawnImpl = spawn, timeoutMs = 15_000 } = {},
) {
  const target = serverAddress(address);
  signal?.throwIfAborted();
  if (target.kind === 'local')
    return { origin: target.origin, fetchImpl: globalThis.fetch, close: async () => {} };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-ssh-'));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, 'forward');
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let child,
    exited = false,
    failed = false,
    closing;
  const close = () =>
    (closing ||= (async () => {
      if (child && !exited) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => {
            if (exited) resolve();
            else child.once('exit', resolve);
          }),
          delay(1500),
        ]);
        if (!exited) {
          child.kill('SIGKILL');
          await Promise.race([
            new Promise((resolve) => {
              if (exited) resolve();
              else child.once('exit', resolve);
            }),
            delay(1500),
          ]);
        }
      }
      if (exited || !child) fs.rmSync(directory, { recursive: true, force: true });
    })());
  const aborted = () => {
    void close();
  };
  try {
    child = spawnImpl(
      'ssh',
      [
        '-F',
        '/dev/null',
        '-N',
        '-T',
        '-a',
        '-x',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=2',
        '-o',
        'ControlMaster=no',
        '-o',
        'ControlPath=none',
        '-p',
        String(target.sshPort),
        ...(target.user ? ['-l', target.user] : []),
        '-L',
        `${socketPath}:127.0.0.1:${target.serverPort}`,
        '--',
        target.host,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    child.once('error', () => {
      failed = true;
      exited = true;
      resolveClosed();
    });
    child.once('exit', () => {
      exited = true;
      resolveClosed();
    });
    signal?.addEventListener('abort', aborted, { once: true });
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(socketPath)) {
      signal?.throwIfAborted();
      if (exited || failed || Date.now() >= deadline) throw new Error('SSH tunnel failed.');
      await delay(20, undefined, { signal });
    }
    if (!fs.lstatSync(socketPath).isSocket() || exited) throw new Error('SSH tunnel failed.');
    const fetchImpl = (input, options = {}) =>
      new Promise((resolve, reject) => {
        const url = new URL(input);
        if (
          url.origin !== target.origin ||
          url.username ||
          url.password ||
          url.hash ||
          url.search ||
          exited ||
          closing
        ) {
          reject(new Error('SSH transport unavailable.'));
          return;
        }
        const request = http.request(
          url,
          {
            socketPath,
            method: options.method || 'GET',
            signal: options.signal,
            headers: Object.fromEntries(new Headers(options.headers)),
          },
          (response) => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const item of value) headers.append(name, item);
              else if (value !== undefined) headers.set(name, value);
            }
            resolve(
              new Response(Readable.toWeb(response), { status: response.statusCode, headers }),
            );
          },
        );
        request.on('error', reject);
        request.end(options.body);
      });
    return {
      origin: target.origin,
      closed,
      fetchImpl,
      createConnection: () => net.connect({ path: socketPath }),
      close: async () => {
        signal?.removeEventListener('abort', aborted);
        await close();
      },
    };
  } catch {
    signal?.removeEventListener('abort', aborted);
    await close();
    throw new Error(
      'SSH tunnel could not start. Install OpenSSH on the client host and verify key login and the known host key first. No enrollment was retried.',
    );
  }
}
