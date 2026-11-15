import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownBlocks, renderMarkdown, safeLink, MARKDOWN_LIMITS } from '../web/public/markdown.js';
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
  const code = '<script>alert(1)</script>\n**not bold**\n# not heading\nconst x = `value`;\n- [x] task\n[link](https://example.org/)';
  const root = renderMarkdown(document, `Before\n\n\`\`\`js\n${code}\n\`\`\`\n\nAfter`);
  const nodes = walk(root), block = nodes.find(node => node.tag === 'pre');
  assert.equal(block.children[0].tag, 'code'); assert.equal(text(block), code);
  assert.ok(nodes.some(node => node.tag === 'small' && node.textContent === 'js'));
  assert.ok(!walk(block).some(node => ['script', 'strong', 'h1', 'input', 'a', 'table'].includes(node.tag)));
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

test('raw HTML, unsafe links/images and malicious fence info cannot create active DOM or arbitrary attributes', () => {
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

test('bullet/ordered/nested lists render bounded structure and task checkboxes are disabled view-only state', () => {
  const root = renderMarkdown(document, '- First **bold**\n  - Nested\n  - [x] Done\n- [ ] Pending\n\n3. Third\n4. Fourth');
  const nodes = walk(root), lists = nodes.filter(node => ['ul', 'ol'].includes(node.tag));
  assert.equal(lists.length, 3);
  assert.equal(lists.find(node => node.tag === 'ol').start, 3);
  assert.ok(nodes.some(node => node.tag === 'strong' && text(node) === 'bold'));
  const boxes = nodes.filter(node => node.tag === 'input');
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes.map(box => box.checked), [true, false]);
  for (const box of boxes) { assert.equal(box.type, 'checkbox'); assert.equal(box.disabled, true); assert.equal(box.tabIndex, -1); assert.ok(!Object.hasOwn(box, 'onclick')); }
});

test('pipe tables support alignment, escaped pipes, code spans, formatting and safe links in cells', () => {
  const root = renderMarkdown(document, '| Name | Value | Link |\n| :--- | :---: | ---: |\n| **A** | `a|b` | [Docs](https://example.org/path) |\n| B | a\\|b | plain |');
  const nodes = walk(root), table = nodes.find(node => node.tag === 'table');
  assert.ok(table); assert.equal(nodes.filter(node => node.tag === 'tr').length, 3);
  assert.deepEqual(nodes.filter(node => node.tag === 'th').map(node => node.className), ['align-left', 'align-center', 'align-right']);
  assert.ok(nodes.filter(node => node.tag === 'th').every(node => node.scope === 'col'));
  assert.ok(nodes.some(node => node.tag === 'code' && text(node) === 'a|b'));
  assert.ok(text(table).includes('a|b'));
  assert.equal(nodes.find(node => node.tag === 'a').href, 'https://example.org/path');
  assert.ok(walk(renderMarkdown(document, '| Only |\n| --- |\n| one |')).some(node => node.tag === 'table'));
  const mismatch = renderMarkdown(document, '| A | B |\n| --- | --- |\n| one | two | extra |');
  assert.ok(text(mismatch).includes('extra'), 'Mismatched rows must remain visible as text, not silently drop cells.');
});

test('explicit HTTP(S) links open separately with noopener/noreferrer and no referrer', () => {
  const root = renderMarkdown(document, '[**Docs**](https://example.org/a_(b)?q=1#part) and <http://example.net/path>');
  const links = walk(root).filter(node => node.tag === 'a'); assert.equal(links.length, 2);
  assert.equal(links[0].href, 'https://example.org/a_(b)?q=1#part');
  assert.ok(walk(links[0]).some(node => node.tag === 'strong' && text(node) === 'Docs'));
  for (const link of links) { assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.referrerPolicy, 'no-referrer'); assert.match(link.title, /^Extern länk: https?:\/\//); }
  assert.ok(safeLink('HTTPS://example.org'));
});

test('unsafe/relative/credentialed/obfuscated links and images remain non-active text', () => {
  const unsafe = ['javascript:alert(1)', 'data:text/html,attack', 'file:///etc/passwd', 'mailto:x@example.org', '//example.org', '/relative', 'https://user:secret@example.org/', 'https://example.org/with space', 'https://example.org/\\\\x', 'https://exa\nmple.org', 'https://example.org/\u0000', 'https://'];
  for (const url of unsafe) {
    assert.equal(safeLink(url), null, JSON.stringify(url));
    assert.ok(!walk(renderMarkdown(document, `[click](${url})`)).some(node => node.tag === 'a'), JSON.stringify(url));
  }
  const root = renderMarkdown(document, '![pixel](https://example.org/pixel) ` [code](https://example.org) ` \\[literal](https://example.org)');
  assert.ok(!walk(root).some(node => ['img', 'a', 'iframe', 'script'].includes(node.tag)));
});

test('unfinished streamed table/link/task syntax is safe and bounded after final reconciliation', () => {
  for (const source of ['[Docs](https://example.org', '| A | B |\n| --', '- [']) {
    assert.ok(!walk(renderMarkdown(document, source)).some(node => ['a', 'input', 'table'].includes(node.tag)));
  }
  assert.equal(walk(renderMarkdown(document, '[Docs](https://example.org)')).filter(node => node.tag === 'a').length, 1);
  assert.equal(safeLink('https://example.org/' + 'x'.repeat(MARKDOWN_LIMITS.urlChars)), null);
  assert.equal(safeLink('https://example.org/' + 'å'.repeat(800)), null, 'Also bound the normalized/percent-encoded href.');
  assert.ok(!walk(renderMarkdown(document, `[${'x'.repeat(MARKDOWN_LIMITS.linkLabelChars + 1)}](https://example.org/)`)).some(node => node.tag === 'a'));
  const nesting = (node, depth = 0) => Math.max(depth, ...node.children.map(child => nesting(child, depth + (['ul', 'ol'].includes(child.tag) ? 1 : 0))));
  assert.ok(nesting(renderMarkdown(document, Array.from({ length: 100 }, (_, index) => '  '.repeat(index) + '- item').join('\n'))) <= MARKDOWN_LIMITS.depth);
  const cells = Array.from({ length: MARKDOWN_LIMITS.columns + 1 }, () => 'x').join('|');
  assert.ok(!walk(renderMarkdown(document, `${cells}\n${cells.replaceAll('x', '---')}`)).some(node => node.tag === 'table'));
  for (const source of ['- [ ] item\n'.repeat(2000), '| A | B |\n| --- | --- |\n' + '| x | y |\n'.repeat(2000), '['.repeat(20000)]) {
    assert.ok(walk(renderMarkdown(document, source)).length < 2200);
    assert.ok(markdownBlocks(source).length <= MARKDOWN_LIMITS.blocks);
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
