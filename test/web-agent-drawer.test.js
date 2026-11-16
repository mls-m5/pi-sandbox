import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAgentDrawer } from '../web/public/agent-drawer.js';
function fixture(mobile = true) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { open: id === 'agent-panel', hidden: false, handlers: {}, classList: { add() {} }, setAttribute(name, value) { this[name] = value; }, addEventListener(name, handler) { this.handlers[name] = handler; }, close() { this.open = false; this.modal = false; this.handlers.close?.(); }, show() { this.open = true; this.modal = false; }, showModal() { this.open = true; this.modal = true; }, getBoundingClientRect() { return { left: 0, right: 300, top: 0, bottom: 700 }; } });
    return nodes.get(id);
  }
  let change;
  const media = { matches: mobile, addEventListener(_name, callback) { change = callback; }, removeEventListener() { change = null; } };
  const drawer = createAgentDrawer({ document: { getElementById: node }, matchMedia: () => media });
  return { drawer, panel: node('agent-panel'), button: node('agent-menu'), close: node('agent-menu-close'), resize(matches) { media.matches = matches; change?.(); } };
}
test('mobile menu opens only after login and explicit click, closes on selection/backdrop/native Escape', () => {
  const f = fixture(); assert.equal(f.panel.open, false); assert.equal(f.button.hidden, true);
  f.button.handlers.click(); assert.equal(f.panel.open, false);
  f.drawer.setActive(true); assert.equal(f.button.hidden, false);
  f.button.handlers.click(); assert.equal(f.panel.modal, true); assert.equal(f.button['aria-expanded'], 'true');
  f.panel.close(); assert.equal(f.button['aria-expanded'], 'false', 'Native dialog Escape/close resets expanded state.');
  f.button.handlers.click(); f.drawer.close(); assert.equal(f.panel.open, false);
  f.button.handlers.click(); f.panel.handlers.click({ target: f.panel, clientX: 400, clientY: 20 }); assert.equal(f.panel.open, false);
  f.button.handlers.click(); f.close.handlers.click(); assert.equal(f.panel.open, false);
  f.button.handlers.click(); f.drawer.setActive(false); assert.equal(f.panel.open, false); assert.equal(f.button.hidden, true);
});
test('responsive transitions restore desktop panel without leaving a modal or automatically opening mobile', () => {
  const f = fixture(false); f.drawer.setActive(true); assert.equal(f.panel.open, true); assert.equal(f.panel.modal, false); assert.equal(f.button.hidden, true);
  f.resize(true); assert.equal(f.panel.open, false); assert.equal(f.button.hidden, false);
  f.button.handlers.click(); assert.equal(f.panel.modal, true);
  f.resize(false); assert.equal(f.panel.open, true); assert.equal(f.panel.modal, false); assert.equal(f.button.hidden, true);
  f.drawer.destroy(); assert.equal(f.button.hidden, true);
});
test('markup gives drawer a native modal label and controls, with narrow view styling and no duplicate IDs', () => {
  const html = fs.readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8'), css = fs.readFileSync(new URL('../web/public/style.css', import.meta.url), 'utf8');
  assert.match(html, /<dialog id="agent-panel" aria-labelledby="agent-menu-title" open>/);
  assert.match(html, /aria-controls="agent-panel"/);
  assert.match(css, /#agent-panel\.drawer-supported:modal/);
  assert.match(css, /height: 100dvh/);
  const panel = html.slice(html.indexOf('<dialog'), html.indexOf('</dialog>'));
  for (const id of ['agents', 'pending-clients', 'server-update', 'diagnostics', 'logout']) assert.ok(panel.includes(`id="${id}"`));
});
