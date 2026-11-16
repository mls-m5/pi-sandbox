import fs from 'node:fs';
import path from 'node:path';
import { NAME_PATTERN, ID_PATTERN } from '../src/config.js';
import { assert, atomicWrite, withLock } from '../src/util.js';
import { validateEnrollment, labelValid } from './enrollment.js';
import { exact, idValid, generationValid } from './common.js';
import { serverAddress } from './server-address.js';

export function localServerOrigin(value) {
  assert(typeof value === 'string' && value.length <= 256, 'Invalid local server origin.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid local server origin.');
  }
  assert(
    url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'Only http://127.0.0.1:PORT is supported; TLS/LAN is not implemented.',
  );
  return url.origin;
}
export function validateAgentProfile(record) {
  assert(
    exact(record, [
      'version',
      'origin',
      'token',
      'agentId',
      'kind',
      'projectId',
      ...(Object.hasOwn(record || {}, 'clientId') ? ['clientId'] : []),
    ]) && record.version === 1,
    'Invalid agent profile.',
  );
  assert(
    record.clientId === undefined || generationValid(record.clientId),
    'Invalid client identity.',
  );
  assert(
    record.origin === serverAddress(record.origin).address &&
      typeof record.token === 'string' &&
      record.token.length === 43 &&
      /^[A-Za-z0-9_-]{43}$/.test(record.token) &&
      idValid(record.agentId),
    'Invalid agent profile.',
  );
  assert(
    record.kind === 'dummy'
      ? record.projectId === null
      : record.kind === 'pi' && ID_PATTERN.test(record.projectId),
    'Invalid local agent project.',
  );
  return record;
}
function profilePath(root, name) {
  assert(
    path.isAbsolute(root) && typeof name === 'string' && NAME_PATTERN.test(name),
    'Invalid local agent profile name.',
  );
  const directory = path.join(root, 'web-agents');
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  assert(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0,
    'Agent profile directory must be private and owned by you.',
  );
  return path.join(directory, `${name}.json`);
}
function readFile(file) {
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Unsafe or unreadable agent profile.');
  }
  try {
    const stat = fs.fstatSync(fd);
    assert(
      stat.isFile() &&
        stat.uid === process.getuid() &&
        stat.nlink === 1 &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 8192,
      'Unsafe agent profile file.',
    );
    return validateAgentProfile(JSON.parse(fs.readFileSync(fd, 'utf8')));
  } catch {
    throw new Error('Invalid or unsafe agent profile.');
  } finally {
    fs.closeSync(fd);
  }
}
export function readAgentProfile(root, name) {
  return readFile(profilePath(root, name));
}
export function readDefaultServer(root) {
  const file = preferencePath(root);
  const value = readPrivateJson(file);
  if (value === undefined) return undefined;
  assert(exact(value, ['origin']), 'Invalid default server preference.');
  return serverAddress(value.origin).address;
}
export async function saveDefaultServer(root, origin) {
  origin = serverAddress(origin).address;
  const file = preferencePath(root);
  await withLock(`${file}.lock`, () => {
    readPrivateJson(file);
    atomicWrite(file, `${JSON.stringify({ origin })}\n`);
  });
}
function preferencePath(root) {
  assert(path.isAbsolute(root), 'Invalid profile root.');
  const stat = fs.lstatSync(root);
  assert(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0,
    'Client preference directory must be private and owned by you.',
  );
  return path.join(root, 'web-client.json');
}
function readPrivateJson(file) {
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Unsafe or unreadable client preference.');
  }
  try {
    const stat = fs.fstatSync(fd);
    assert(
      stat.isFile() &&
        stat.uid === process.getuid() &&
        stat.nlink === 1 &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 8192,
      'Unsafe client preference file.',
    );
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch {
    throw new Error('Invalid or unsafe client preference.');
  } finally {
    fs.closeSync(fd);
  }
}
export async function saveAgentProfile(root, name, record, { replace = false } = {}) {
  validateAgentProfile(record);
  const file = profilePath(root, name);
  await withLock(`${file}.lock`, () => {
    const existing = readFile(file);
    assert(
      !existing || replace,
      'Agent profile exists; use --replace to replace its registration.',
    );
    atomicWrite(file, `${JSON.stringify(record)}\n`);
  });
}
export async function forgetAgentProfile(root, name) {
  const file = profilePath(root, name);
  await withLock(`${file}.lock`, () => {
    readFile(file);
    fs.rmSync(file, { force: true });
  });
}
export async function enrollAgent(
  origin,
  token,
  enrollment,
  { fetchImpl = globalThis.fetch } = {},
) {
  validateEnrollment(enrollment);
  const value = await agentRequest(origin, token, '/agent/enroll', { fetchImpl, enrollment });
  assert(
    exact(value, ['id', 'token', 'kind', 'label']) &&
      idValid(value.id) &&
      value.kind === enrollment.kind &&
      labelValid(value.label) &&
      typeof value.token === 'string' &&
      value.token.length === 43 &&
      /^[A-Za-z0-9_-]{43}$/.test(value.token),
    'Invalid enrollment result.',
  );
  return value;
}
export async function identifyAgent(origin, token, { fetchImpl = globalThis.fetch } = {}) {
  const value = await agentRequest(origin, token, '/agent/identity', { fetchImpl });
  assert(
    exact(value, ['id', 'kind']) && idValid(value.id) && ['dummy', 'pi'].includes(value.kind),
    'Agent identity not accepted.',
  );
  return value;
}
async function agentRequest(origin, token, route, { fetchImpl, enrollment } = {}) {
  origin = localServerOrigin(origin);
  assert(
    typeof token === 'string' && token.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(token),
    'Invalid agent key.',
  );
  let reader;
  try {
    const response = await fetchImpl(`${origin}${route}`, {
      method: enrollment ? 'POST' : 'GET',
      redirect: 'error',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(enrollment ? { 'Content-Type': 'application/json', 'X-Pis-Web': '1' } : {}),
      },
      ...(enrollment ? { body: JSON.stringify(enrollment) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    reader = response.body?.getReader();
    if (response.status === 409)
      throw Object.assign(new Error('Registration conflict.'), { code: 'ENROLLMENT_CONFLICT' });
    assert(response.ok && !response.redirected && reader, 'Registration not accepted.');
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert(bytes <= 1024, 'Invalid identity response.');
      chunks.push(value);
    }
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
    );
    return value;
  } catch (error) {
    if (error.code === 'ENROLLMENT_CONFLICT') throw error;
    throw new Error(
      'Server unavailable or agent key not accepted. Check the server and create a new registration after a server restart.',
    );
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
}
