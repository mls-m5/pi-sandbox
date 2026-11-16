// Small bounded Markdown subset, not a CommonMark/HTML parser. Every untrusted
// string becomes textContent. Only validated explicit HTTP(S) links get href;
// images, raw HTML, arbitrary attributes/classes and executable content stay off.
export const MARKDOWN_LIMITS = Object.freeze({
  chars: 16384,
  blocks: 128,
  nodes: 512,
  depth: 4,
  items: 64,
  columns: 12,
  rows: 64,
  urlChars: 2048,
  linkLabelChars: 512,
});
const textNode = (text) => ({ type: 'text', text });

export function safeLink(source) {
  if (
    typeof source !== 'string' ||
    source.length > MARKDOWN_LIMITS.urlChars ||
    !/^https?:\/\//i.test(source) ||
    /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(source)
  )
    return null;
  try {
    const url = new URL(source);
    return ['http:', 'https:'].includes(url.protocol) &&
      url.hostname &&
      !url.username &&
      !url.password &&
      url.href.length <= MARKDOWN_LIMITS.urlChars
      ? { href: url.href, origin: url.origin }
      : null;
  } catch {
    return null;
  }
}
function linkAt(text, index) {
  if (text[index] === '<') {
    if (!/^https?:\/\//i.test(text.slice(index + 1, index + 9))) return null;
    const offset = text.slice(index + 1, index + MARKDOWN_LIMITS.urlChars + 2).indexOf('>');
    if (offset < 0) return null;
    const end = index + 1 + offset;
    const label = text.slice(index + 1, end),
      link = safeLink(label);
    return link ? { ...link, label, end: end + 1 } : null;
  }
  if (text[index] !== '[' || text[index - 1] === '!') return null;
  const offset = text.slice(index + 1, index + MARKDOWN_LIMITS.linkLabelChars + 3).indexOf('](');
  if (offset <= 0 || offset > MARKDOWN_LIMITS.linkLabelChars) return null;
  const labelEnd = index + 1 + offset;
  const start = labelEnd + 2;
  let nesting = 1;
  for (let end = start; end < text.length && end - start <= MARKDOWN_LIMITS.urlChars; end++) {
    if (text[end] === '(' && ++nesting > MARKDOWN_LIMITS.depth) return null;
    if (text[end] !== ')' || --nesting !== 0) continue;
    const link = safeLink(text.slice(start, end));
    return link ? { ...link, label: text.slice(index + 1, labelEnd), end: end + 1 } : null;
  }
  return null;
}
function inline(text, budget, depth = 0, allowLinks = true) {
  if (depth >= MARKDOWN_LIMITS.depth || budget.nodes <= 1) return [textNode(text)];
  const result = [];
  let plain = '',
    index = 0;
  const flush = () => {
    if (plain) {
      result.push(textNode(plain));
      budget.nodes--;
      plain = '';
    }
  };
  while (index < text.length && budget.nodes > 2) {
    const char = text[index];
    if (char === '\\' && text[index + 1] && '\\*_`[]()<>|'.includes(text[index + 1])) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    const link = allowLinks && (char === '[' || char === '<') ? linkAt(text, index) : null;
    if (link) {
      flush();
      budget.nodes--;
      result.push({
        type: 'link',
        href: link.href,
        origin: link.origin,
        children: inline(link.label, budget, depth + 1, false),
      });
      index = link.end;
      continue;
    }
    if (!['*', '_', '`'].includes(char)) {
      plain += char;
      index++;
      continue;
    }
    const marker = text.startsWith(char.repeat(2), index) ? char.repeat(2) : char;
    const start = index + marker.length;
    let end = text.indexOf(marker, start);
    if (
      char !== '`' &&
      marker.length === 2 &&
      end >= 0 &&
      text[end + 2] === char &&
      text.slice(start, end).includes(char)
    )
      end++;
    const word = char === '_' && /[\p{L}\p{N}]/u.test(text[index - 1] || '');
    const body = end >= 0 ? text.slice(start, end) : '';
    if (
      end < 0 ||
      !body ||
      word ||
      (char !== '`' &&
        (/^\s|\s$/.test(body) ||
          body.includes('\n') ||
          (char === '_' && /[\p{L}\p{N}]/u.test(text[end + marker.length] || ''))))
    ) {
      plain += char;
      index++;
      continue;
    }
    flush();
    budget.nodes--;
    if (char === '`') result.push({ type: 'code', text: body });
    else
      result.push({
        type: marker.length === 2 ? 'strong' : 'em',
        children: inline(body, budget, depth + 1, allowLinks),
      });
    index = end + marker.length;
  }
  plain += text.slice(index);
  flush();
  return result;
}

function listLine(line) {
  const match = /^([ \t]*)([-+*]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line);
  if (!match) return null;
  const task = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(match[3]);
  return {
    indent: match[1].replaceAll('\t', '    ').length,
    ordered: /\d/.test(match[2][0]),
    start: parseInt(match[2], 10),
    body: task ? task[2] || '' : match[3],
    checked: task ? task[1].toLowerCase() === 'x' : null,
  };
}
function readList(lines, index, budget, depth = 0) {
  const first = listLine(lines[index]);
  const block = {
    type: 'list',
    ordered: first.ordered,
    start: first.ordered ? first.start : 1,
    items: [],
  };
  while (index < lines.length && block.items.length < MARKDOWN_LIMITS.items && budget.nodes > 4) {
    const entry = listLine(lines[index]);
    if (!entry || entry.indent !== first.indent || entry.ordered !== first.ordered) break;
    budget.nodes -= entry.checked === null ? 1 : 3;
    const item = { children: inline(entry.body, budget), checked: entry.checked, nested: [] };
    block.items.push(item);
    index++;
    while (index < lines.length && budget.nodes > 4 && depth + 1 < MARKDOWN_LIMITS.depth) {
      const next = listLine(lines[index]);
      if (!next || next.indent <= first.indent) break;
      const child = readList(lines, index, budget, depth + 1);
      if (child.next === index) break;
      item.nested.push(child.block);
      index = child.next;
    }
  }
  return { block, next: index };
}
function tableCells(line) {
  if (!line.includes('|')) return null;
  const cells = [];
  let cell = '',
    ticks = 0;
  const source = line.trim();
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\' && source[index + 1]) {
      cell += char + source[++index];
      continue;
    }
    if (char === '`') {
      let end = index;
      while (source[end] === '`') end++;
      const run = end - index;
      if (!ticks) ticks = run;
      else if (ticks === run) ticks = 0;
      cell += source.slice(index, end);
      index = end - 1;
      continue;
    }
    if (char === '|' && !ticks) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
    if (cells.length > MARKDOWN_LIMITS.columns + 1) return null;
  }
  cells.push(cell.trim());
  if (source.startsWith('|') && cells[0] === '') cells.shift();
  if (source.endsWith('|') && cells.at(-1) === '') cells.pop();
  return cells.length && cells.length <= MARKDOWN_LIMITS.columns ? cells : null;
}
function tableHeader(lines, index) {
  const header = tableCells(lines[index]),
    separator = tableCells(lines[index + 1] || '');
  if (
    !header ||
    separator?.length !== header.length ||
    !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
  )
    return null;
  return {
    header,
    align: separator.map((cell) =>
      cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left',
    ),
  };
}
function readTable(lines, index, spec, budget) {
  const row = (cells) => {
    budget.nodes -= cells.length + 1;
    return cells.map((cell) => inline(cell, budget));
  };
  const block = { type: 'table', align: spec.align, header: row(spec.header), rows: [] };
  index += 2;
  while (
    index < lines.length &&
    block.rows.length < MARKDOWN_LIMITS.rows &&
    budget.nodes > spec.header.length * 2 + 2
  ) {
    const cells = tableCells(lines[index]);
    if (!cells || cells.length !== spec.header.length || !lines[index].trim()) break;
    block.rows.push(row(cells));
    index++;
  }
  return { block, next: index };
}

export function markdownBlocks(source) {
  const original = typeof source === 'string' ? source : '';
  const text = original.slice(0, MARKDOWN_LIMITS.chars).replaceAll('\r\n', '\n');
  const lines = text.split('\n'),
    blocks = [],
    budget = { nodes: MARKDOWN_LIMITS.nodes };
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', children: inline(paragraph.join('\n'), budget) });
      paragraph = [];
    }
  };
  for (let index = 0; index < lines.length; index++) {
    if (
      blocks.length + (paragraph.length ? 1 : 0) >= MARKDOWN_LIMITS.blocks - 2 ||
      budget.nodes <= 2
    ) {
      paragraph.push(...lines.slice(index));
      flush();
      break;
    }
    const line = lines[index];
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      flush();
      const code = [];
      for (index++; index < lines.length; index++) {
        const close = /^ {0,3}([`~]+)[ \t]*$/.exec(lines[index]);
        if (
          close &&
          close[1].length >= fence[1].length &&
          [...close[1]].every((char) => char === fence[1][0])
        )
          break;
        code.push(lines[index]);
      }
      blocks.push({ type: 'code', text: code.join('\n'), language: fence[2].trim().slice(0, 40) });
      budget.nodes--;
    } else {
      const table = tableHeader(lines, index),
        list = listLine(line);
      if (table) {
        flush();
        const parsed = readTable(lines, index, table, budget);
        blocks.push(parsed.block);
        index = parsed.next - 1;
        continue;
      }
      if (list) {
        flush();
        if (budget.nodes <= 4) {
          paragraph.push(...lines.slice(index));
          flush();
          break;
        }
        const parsed = readList(lines, index, budget);
        blocks.push(parsed.block);
        index = parsed.next - 1;
        continue;
      }
      const heading = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line);
      if (heading) {
        flush();
        blocks.push({
          type: 'heading',
          level: heading[1].length,
          children: inline(heading[2], budget),
        });
      } else if (!line.trim()) flush();
      else paragraph.push(line);
    }
  }
  flush();
  if (original.length > MARKDOWN_LIMITS.chars)
    blocks.push({ type: 'paragraph', children: [textNode('[förkortat]')] });
  return blocks;
}

function appendInline(document, parent, children) {
  for (const node of children) {
    const tag =
      node.type === 'link'
        ? 'a'
        : node.type === 'strong'
          ? 'strong'
          : node.type === 'em'
            ? 'em'
            : node.type === 'code'
              ? 'code'
              : 'span';
    const element = document.createElement(tag);
    if (node.type === 'link') {
      element.href = node.href;
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
      element.referrerPolicy = 'no-referrer';
      element.title = `Extern länk: ${node.origin}`;
    }
    if (node.children) appendInline(document, element, node.children);
    else element.textContent = node.text;
    parent.append(element);
  }
}
function renderList(document, block) {
  const list = document.createElement(block.ordered ? 'ol' : 'ul');
  if (block.ordered) list.start = block.start;
  for (const item of block.items) {
    const li = document.createElement('li');
    if (item.checked === null) appendInline(document, li, item.children);
    else {
      li.className = 'task-item';
      const label = document.createElement('label'),
        checkbox = document.createElement('input'),
        body = document.createElement('span');
      label.className = 'task-label';
      checkbox.type = 'checkbox';
      checkbox.checked = item.checked;
      checkbox.disabled = true;
      checkbox.tabIndex = -1;
      appendInline(document, body, item.children);
      label.append(checkbox, body);
      li.append(label);
    }
    for (const nested of item.nested) li.append(renderList(document, nested));
    list.append(li);
  }
  return list;
}
function renderTable(document, block) {
  const wrapper = document.createElement('div'),
    table = document.createElement('table'),
    head = document.createElement('thead'),
    body = document.createElement('tbody');
  wrapper.className = 'markdown-table';
  const row = (cells, heading) => {
    const tr = document.createElement('tr');
    for (let column = 0; column < cells.length; column++) {
      const cell = document.createElement(heading ? 'th' : 'td');
      cell.className = `align-${block.align[column]}`;
      if (heading) cell.scope = 'col';
      appendInline(document, cell, cells[column]);
      tr.append(cell);
    }
    return tr;
  };
  head.append(row(block.header, true));
  for (const cells of block.rows) body.append(row(cells, false));
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}
export function renderMarkdown(document, source) {
  const root = document.createElement('div');
  root.className = 'markdown';
  for (const block of markdownBlocks(source)) {
    if (block.type === 'code') {
      if (block.language) {
        const label = document.createElement('small');
        label.className = 'code-language';
        label.textContent = block.language;
        root.append(label);
      }
      const pre = document.createElement('pre'),
        code = document.createElement('code');
      code.textContent = block.text;
      pre.append(code);
      root.append(pre);
    } else if (block.type === 'list') root.append(renderList(document, block));
    else if (block.type === 'table') root.append(renderTable(document, block));
    else {
      const element = document.createElement(block.type === 'heading' ? `h${block.level}` : 'p');
      appendInline(document, element, block.children);
      root.append(element);
    }
  }
  return root;
}
