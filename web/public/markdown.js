// Small bounded Markdown subset, not a CommonMark/HTML parser. Every untrusted
// string becomes textContent; no URLs, images, attributes or language classes.
export const MARKDOWN_LIMITS = Object.freeze({ chars: 16384, blocks: 128, nodes: 512, depth: 4 });
const textNode = text => ({ type: 'text', text });

function inline(text, budget, depth = 0) {
  if (depth >= MARKDOWN_LIMITS.depth || budget.nodes <= 1) return [textNode(text)];
  const result = []; let plain = '', index = 0;
  const flush = () => { if (plain) { result.push(textNode(plain)); budget.nodes--; plain = ''; } };
  while (index < text.length && budget.nodes > 2) {
    const char = text[index];
    if (char === '\\' && /[\\*_`]/.test(text[index + 1] || '')) { plain += text[index + 1]; index += 2; continue; }
    if (!['*', '_', '`'].includes(char)) { plain += char; index++; continue; }
    const marker = text.startsWith(char.repeat(2), index) ? char.repeat(2) : char;
    const start = index + marker.length;
    let end = text.indexOf(marker, start);
    if (char !== '`' && marker.length === 2 && end >= 0 && text[end + 2] === char && text.slice(start, end).includes(char)) end++;
    const word = char === '_' && /[\p{L}\p{N}]/u.test(text[index - 1] || '');
    const body = end >= 0 ? text.slice(start, end) : '';
    if (end < 0 || !body || word || (char !== '`' && (/^\s|\s$/.test(body) || body.includes('\n') || (char === '_' && /[\p{L}\p{N}]/u.test(text[end + marker.length] || ''))))) {
      plain += char; index++; continue;
    }
    flush(); budget.nodes--;
    if (char === '`') result.push({ type: 'code', text: body });
    else result.push({ type: marker.length === 2 ? 'strong' : 'em', children: inline(body, budget, depth + 1) });
    index = end + marker.length;
  }
  plain += text.slice(index); flush(); return result;
}

export function markdownBlocks(source) {
  const original = typeof source === 'string' ? source : '';
  const text = original.slice(0, MARKDOWN_LIMITS.chars).replaceAll('\r\n', '\n');
  const lines = text.split('\n'), blocks = [], budget = { nodes: MARKDOWN_LIMITS.nodes };
  let paragraph = [];
  const flush = () => { if (paragraph.length) { blocks.push({ type: 'paragraph', children: inline(paragraph.join('\n'), budget) }); paragraph = []; } };
  for (let index = 0; index < lines.length; index++) {
    if (blocks.length + (paragraph.length ? 1 : 0) >= MARKDOWN_LIMITS.blocks - 2 || budget.nodes <= 2) {
      paragraph.push(...lines.slice(index)); flush(); break;
    }
    const line = lines[index];
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      flush(); const code = [];
      for (index++; index < lines.length; index++) {
        const close = /^ {0,3}([`~]+)[ \t]*$/.exec(lines[index]);
        if (close && close[1].length >= fence[1].length && [...close[1]].every(char => char === fence[1][0])) break;
        code.push(lines[index]);
      }
      blocks.push({ type: 'code', text: code.join('\n'), language: fence[2].trim().slice(0, 40) }); budget.nodes--;
    } else {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line);
      if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, children: inline(heading[2], budget) }); }
      else if (!line.trim()) flush();
      else paragraph.push(line);
    }
  }
  flush();
  if (original.length > MARKDOWN_LIMITS.chars) blocks.push({ type: 'paragraph', children: [textNode('[förkortat]')] });
  return blocks;
}

function appendInline(document, parent, children) {
  for (const node of children) {
    const tag = node.type === 'strong' ? 'strong' : node.type === 'em' ? 'em' : node.type === 'code' ? 'code' : 'span';
    const element = document.createElement(tag);
    if (node.children) appendInline(document, element, node.children);
    else element.textContent = node.text;
    parent.append(element);
  }
}
export function renderMarkdown(document, source) {
  const root = document.createElement('div'); root.className = 'markdown';
  for (const block of markdownBlocks(source)) {
    if (block.type === 'code') {
      if (block.language) { const label = document.createElement('small'); label.className = 'code-language'; label.textContent = block.language; root.append(label); }
      const pre = document.createElement('pre'), code = document.createElement('code'); code.textContent = block.text;
      pre.append(code); root.append(pre);
    } else {
      const element = document.createElement(block.type === 'heading' ? `h${block.level}` : 'p');
      appendInline(document, element, block.children); root.append(element);
    }
  }
  return root;
}
