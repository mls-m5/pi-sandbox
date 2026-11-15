import fs from 'node:fs';
import path from 'node:path';
import { NAME_PATTERN, ID_PATTERN } from '../src/config.js';
import { assert, atomicWrite, withLock } from '../src/util.js';
import { exact, idValid } from './common.js';

export function localServerOrigin(value) {
  assert(typeof value === 'string' && value.length <= 256, 'Invalid local server origin.');
  let url; try { url = new URL(value); } catch { throw new Error('Invalid local server origin.'); }
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash, 'Only http://127.0.0.1:PORT is supported; TLS/LAN is not implemented.');
  return url.origin;
}
export function validateAgentProfile(record) {
  assert(exact(record, ['version', 'origin', 'token', 'agentId', 'kind', 'projectId']) && record.version === 1, 'Invalid agent profile.');
  assert(record.origin === localServerOrigin(record.origin) && typeof record.token === 'string' && record.token.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(record.token) && idValid(record.agentId), 'Invalid agent profile.');
  assert(record.kind === 'dummy' ? record.projectId === null : record.kind === 'pi' && ID_PATTERN.test(record.projectId), 'Invalid local agent project.');
  return record;
}
function profilePath(root, name) {
  assert(path.isAbsolute(root) && typeof name === 'string' && NAME_PATTERN.test(name), 'Invalid local agent profile name.');
  const directory = path.join(root, 'web-agents');
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'Agent profile directory must be private and owned by you.');
  return path.join(directory, `${name}.json`);
}
function readFile(file) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('Unsafe or unreadable agent profile.'); }
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size <= 8192, 'Unsafe agent profile file.');
    return validateAgentProfile(JSON.parse(fs.readFileSync(fd, 'utf8')));
  } catch { throw new Error('Invalid or unsafe agent profile.'); }
  finally { fs.closeSync(fd); }
}
export function readAgentProfile(root, name) { return readFile(profilePath(root, name)); }
export async function saveAgentProfile(root, name, record, { replace = false } = {}) {
  validateAgentProfile(record);
  const file = profilePath(root, name);
  await withLock(`${file}.lock`, () => {
    const existing = readFile(file);
    assert(!existing || replace, 'Agent profile exists; use --replace to replace its registration.');
    atomicWrite(file, `${JSON.stringify(record)}\n`);
  });
}
export async function forgetAgentProfile(root, name) {
  const file = profilePath(root, name);
  await withLock(`${file}.lock`, () => { readFile(file); fs.rmSync(file, { force: true }); });
}
export async function identifyAgent(origin, token, { fetchImpl = globalThis.fetch } = {}) {
  origin = localServerOrigin(origin);
  assert(typeof token === 'string' && token.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(token), 'Invalid agent key.');
  let reader;
  try {
    const response = await fetchImpl(`${origin}/agent/identity`, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    reader = response.body?.getReader();
    assert(response.ok && !response.redirected && reader, 'Registration not accepted.');
    const chunks = []; let bytes = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; assert(bytes <= 1024, 'Invalid identity response.'); chunks.push(value); }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    assert(exact(value, ['id', 'kind']) && idValid(value.id) && ['dummy', 'pi'].includes(value.kind), 'Invalid identity response.');
    return value;
  } catch { throw new Error('Server unavailable or agent key not accepted. Check the server and create a new registration after a server restart.'); }
  finally { if (reader) { try { await reader.cancel(); } finally { reader.releaseLock(); } } }
}
