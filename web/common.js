import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const randomKey = () => randomBytes(32).toString('base64url');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
export const idValid = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
export const generationValid = (value) =>
  typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export const wsOptions = {
  perMessageDeflate: false,
  maxPayload: 272 * 1024,
  maxFragments: 128,
  maxBufferedChunks: 512,
  maxPendingAutoPongs: 4,
  closeTimeout: 1000,
};

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 20 || Buffer.byteLength(password) > 1024)
    throw new Error('Use a password of at least 20 characters (maximum 1024 UTF-8 bytes).');
  const salt = randomBytes(32);
  const hash = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
export async function verifyPassword(password, record) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
  const hash = await derive(password, Buffer.from(record.salt, 'hex'), 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(hash, Buffer.from(record.hash, 'hex'));
}
export function budget(limit, windowMs) {
  let count = 0,
    until = 0;
  return () => {
    if (Date.now() >= until) {
      count = 0;
      until = Date.now() + windowMs;
    }
    return ++count <= limit;
  };
}
export function send(ws, value, maxBytes = 272 * 1024) {
  if (ws.readyState !== 1) return false;
  const text = JSON.stringify(value);
  if (
    Buffer.byteLength(text) > maxBytes ||
    ws.bufferedAmount + Buffer.byteLength(text) > 512 * 1024
  ) {
    ws.terminate();
    return false;
  }
  try {
    ws.send(text, (error) => {
      if (error) ws.terminate();
    });
    return true;
  } catch {
    ws.terminate();
    return false;
  }
}
