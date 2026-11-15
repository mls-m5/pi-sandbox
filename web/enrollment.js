import { assert } from '../src/util.js';
import { generationValid, exact } from './common.js';

export const ENROLLMENT_MS = 10 * 60 * 1000;
export const labelValid = label => typeof label === 'string' && label.trim().length > 0 && label.length <= 80 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(label);
export function validateEnrollment(value) {
  assert(exact(value, ['clientId', 'label', 'kind', 'previousToken']) && generationValid(value.clientId) && labelValid(value.label) && ['pi', 'dummy'].includes(value.kind), 'Invalid enrollment.');
  assert(value.previousToken === null || (typeof value.previousToken === 'string' && value.previousToken.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(value.previousToken)), 'Invalid enrollment proof.');
}
export function uniqueAgentLabel(registrations, label, exceptId) {
  const taken = new Set([...registrations.values()].filter(agent => agent.id !== exceptId).map(agent => agent.label));
  const base = label.trim();
  if (!taken.has(base)) return base;
  for (let number = 2; number <= 34; number++) {
    const suffix = `-${number}`, name = base.slice(0, 80 - suffix.length) + suffix;
    if (!taken.has(name)) return name;
  }
  throw new Error('No free label.');
}
