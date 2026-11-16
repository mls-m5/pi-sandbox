import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegationsUI } from '../web/public/delegations.js';
class Element { children = []; textContent = ''; listeners = {}; append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; } addEventListener(name, fn) { this.listeners[name] = fn; } }
const text = node => node.textContent + node.children.map(text).join('');
function fixture() { const nodes = new Map(), context = { online: true, synchronized: true }; let reads = 0;
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); }, createElement() { return new Element(); } };
  const ui = createDelegationsUI({ document, getContext: () => context, refresh: () => { reads++; } });
  return { ui, context, node: id => document.getElementById(id), reads: () => reads };
}
test('delegation overview reports nested lifecycle without equating completion to semantic success or starting children', () => {
  const f = fixture(); f.ui.update({ runs: [{ id: 'run', label: '<script>literal</script>', state: 'running', model: 'Luna', children: [{ id: 'child', label: 'Review', state: 'complete' }] }], omitted: true });
  assert.match(text(f.node('delegations')), /<script>literal<\/script>/); assert.match(text(f.node('delegations')), /Process avslutad/); assert.match(text(f.node('delegations')), /inte att uppgiften är godkänd/); assert.match(text(f.node('delegations')), /utelämnats/);
  f.context.online = false; f.ui.draw(); assert.match(text(f.node('delegations')), /Status okänd/); assert.equal(f.reads(), 0);
  f.node('refresh-delegations').listeners.click(); assert.equal(f.reads(), 0);
  f.context.online = true; f.node('refresh-delegations').listeners.click(); assert.equal(f.reads(), 1);
  f.ui.clear(); assert.equal(text(f.node('delegations')), '');
});
test('hostile/missing/oversized snapshots stay bounded and cannot invent a completed empty roster', () => {
  const f = fixture(); f.ui.update(null); assert.match(text(f.node('delegations')), /Ingen kompatibel/);
  f.ui.update({ runs: [], omitted: true }); assert.match(text(f.node('delegations')), /ofullständig/); assert.ok(!text(f.node('delegations')).includes('Inga asynkrona'));
  const row = { id: 'x', label: 'x'.repeat(10000), state: { toString: null }, model: 'x'.repeat(10000), sessionFile: 'SECRET', token: 'SECRET' };
  f.ui.update({ runs: Array(10000).fill({ ...row, children: Array(10000).fill(row) }) });
  assert.ok(text(f.node('delegations')).length < 16000); assert.ok(!text(f.node('delegations')).includes('SECRET')); assert.match(text(f.node('delegations')), /Status okänd/);
});
