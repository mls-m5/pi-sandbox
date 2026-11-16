import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/public/style.css', import.meta.url), 'utf8');
test('mobile composer follows conversation with compact named controls and accessible help', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(html.indexOf('id="diagnostics"') < html.indexOf('id="messages"'));
  assert.ok(html.indexOf('id="tools"') < html.indexOf('id="messages"'));
  assert.ok(html.indexOf('id="queued-messages"') < html.indexOf('id="prompt-form"'));
  const form = html.slice(html.indexOf('<form id="prompt-form"'), html.indexOf('</form>', html.indexOf('<form id="prompt-form"')));
  for (const id of ['prompt', 'send', 'stop', 'queue-steer', 'queue-follow-up']) assert.ok(form.includes(`id="${id}"`));
  assert.match(form, /for="prompt"/);
  assert.match(form, /aria-describedby="prompt-help"/);
  assert.match(form, /<summary aria-label="Hjälp för meddelanden">/);
  assert.match(css, /min-height: 44px/);
});
