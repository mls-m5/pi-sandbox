import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownBlocks, renderMarkdown, MARKDOWN_LIMITS } from '../web/public/markdown.js';
import { renderChat, renderTools } from '../web/public/render.js';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
}
const document = { createElement: tag => new Element(tag) };
const walk = element => [element, ...element.children.flatMap(walk)];
const text = element => element.textContent + element.children.map(text).join('');

test('basic ATX headings, bold, italic, nested emphasis and inline code create only fixed formatting nodes', () => {
  const root = renderMarkdown(document, '# Heading\n\n## Second\n\nNormal **bold** and *italic* plus __strong__ and _em_. **bold *inside*** and `literal **not bold**`.');
  const nodes = walk(root);
  assert.equal(nodes.find(node => node.tag === 'h1').children[0].textContent, 'Heading');
  assert.equal(nodes.find(node => node.tag === 'h2').children[0].textContent, 'Second');
  assert.ok(nodes.some(node => node.tag === 'strong' && text(node) === 'bold'));
  assert.ok(nodes.some(node => node.tag === 'em' && text(node) === 'italic'));
  assert.ok(nodes.some(node => node.tag === 'strong' && text(node) === 'strong'));
  assert.ok(nodes.some(node => node.tag === 'em' && text(node) === 'em'));
  assert.ok(nodes.some(node => node.tag === 'code' && text(node) === 'literal **not bold**'));
  assert.ok(nodes.some(node => node.tag === 'strong' && node.children.some(child => child.tag === 'em' && text(child) === 'inside')));
});

test('fenced code preserves content literally, labels language as text and never highlights/executes it', () => {
  const code = '<script>alert(1)</script>\n**not bold**\n# not heading\nconst x = `value`;';
  const root = renderMarkdown(document, `Before\n\n\`\`\`js\n${code}\n\`\`\`\n\nAfter`);
  const nodes = walk(root), block = nodes.find(node => node.tag === 'pre');
  assert.equal(block.children[0].tag, 'code'); assert.equal(text(block), code);
  assert.ok(nodes.some(node => node.tag === 'small' && node.textContent === 'js'));
  assert.ok(!walk(block).some(node => ['script', 'strong', 'h1'].includes(node.tag)));
  const tildes = renderMarkdown(document, '~~~text\nhello\n~~~');
  assert.equal(text(walk(tildes).find(node => node.tag === 'pre')), 'hello');
});

test('unfinished streamed emphasis/fences remain safe and reconcile when final content arrives', () => {
  assert.equal(text(renderMarkdown(document, '**not finished')), '**not finished');
  assert.equal(text(renderMarkdown(document, '```\nunfinished **code')), 'unfinished **code');
  const root = new Element('main');
  const model = { messages: [], partial: { role: 'assistant', content: [{ type: 'text', text: '# Growing\n```\nlet x' }] } };
  renderChat(document, root, model);
  assert.ok(walk(root).some(node => node.tag === 'h1'));
  model.partial = null; model.messages = [{ role: 'assistant', content: [{ type: 'text', text: '**Done**' }] }];
  renderChat(document, root, model);
  assert.equal(root.children.length, 1); assert.ok(walk(root).some(node => node.tag === 'strong' && text(node) === 'Done'));
  assert.ok(!text(root).includes('Growing'));
});

test('HTML, markdown links/images and malicious fence info cannot create active DOM or attributes', () => {
  const hostile = '<img src=x onerror=alert(1)><svg onload=alert(1)> &lt;script&gt;\n[click](javascript:alert(1)) ![pixel](https://evil.invalid/pixel)';
  const root = renderMarkdown(document, `${hostile}\n\n\`\`\`html\" onclick=attack()\n${hostile}\n\`\`\``);
  const nodes = walk(root);
  assert.ok(text(root).includes('<img src=x onerror=alert(1)>'));
  assert.ok(text(root).includes('[click](javascript:alert(1))'));
  for (const node of nodes) {
    assert.ok(['div', 'p', 'span', 'pre', 'code', 'small', 'strong', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(node.tag));
    assert.ok(!Object.hasOwn(node, 'href')); assert.ok(!Object.hasOwn(node, 'src')); assert.ok(!Object.hasOwn(node, 'onclick'));
  }
});

test('user messages, thinking and tool output stay literal; only assistant text uses markdown', () => {
  const root = new Element('main');
  renderChat(document, root, { messages: [{ role: 'user', content: [{ type: 'text', text: '# Literal user' }] }, { role: 'assistant', content: [{ type: 'thinking', text: '**Literal thinking**' }] }, { role: 'toolResult', content: [{ type: 'text', text: '**Literal tool**' }] }], partial: null });
  assert.ok(!walk(root).some(node => /^h[1-6]$/.test(node.tag) || node.tag === 'em'));
  assert.ok(text(root).includes('# Literal user')); assert.ok(text(root).includes('**Literal thinking**')); assert.ok(text(root).includes('**Literal tool**'));
  renderTools(document, root, [{ name: 'read', state: 'klar', text: '```js\nattack()\n```' }]);
  assert.equal(root.children[0].tag, 'pre'); assert.ok(text(root).includes('```js'));
});

test('escapes and snake_case remain readable; hostile repeated markers and many headings are bounded', () => {
  assert.equal(text(renderMarkdown(document, '\\*literal\\* snake_case_name')), '*literal* snake_case_name');
  const source = Array.from({ length: 2000 }, (_, index) => `# Heading ${index} **x** _y_\n`).join('');
  const blocks = markdownBlocks(source);
  assert.ok(blocks.length <= MARKDOWN_LIMITS.blocks);
  assert.ok(walk(renderMarkdown(document, source)).length < 1800);
  const repeated = '*x* '.repeat(4000);
  assert.ok(walk(renderMarkdown(document, repeated)).length < 1200);
  assert.ok(text(renderMarkdown(document, 'x'.repeat(20000))).endsWith('[förkortat]'));
});
