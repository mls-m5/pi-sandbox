import { renderMarkdown } from './markdown.js';

// Dynamic strings remain untrusted. Only the bounded Markdown subset creates
// fixed DOM elements; raw HTML, links, images and terminal parsing stay disabled.
export function renderChat(document, root, model) {
  const nodes = [];
  for (const message of [...model.messages, ...(model.partial ? [model.partial] : [])]) {
    const article = document.createElement('article'); article.className = `message ${message.role === 'user' ? 'user' : 'agent'}`;
    const heading = document.createElement('strong'); heading.textContent = message.role === 'user' ? 'Du' : message.role === 'assistant' ? 'Agent' : message.role;
    article.append(heading);
    for (const block of message.content) {
      if (!block) continue;
      const pre = document.createElement('pre');
      if (block.type === 'text' && message.role === 'assistant') {
        article.append(renderMarkdown(document, block.text));
        if (block.truncated) { const note = document.createElement('small'); note.textContent = '[förkortat]'; article.append(note); }
        continue;
      } else if (block.type === 'text' || block.type === 'thinking') {
        pre.textContent = `${block.type === 'thinking' ? 'Synlig thinking: ' : ''}${block.text}${block.truncated ? '\n[förkortat]' : ''}`;
      } else if (block.type === 'tool_call') pre.textContent = `[Verktygsanrop: ${block.name}; argument utelämnade]`;
      else pre.textContent = `[Utelämnat: ${block.kind || 'innehåll'}]`;
      article.append(pre);
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted' || message.truncated) {
      const note = document.createElement('small'); note.textContent = message.stopReason === 'error' ? 'Agenten rapporterade ett fel.' : message.stopReason === 'aborted' ? 'Avbrutet.' : 'Innehållet är förkortat.'; article.append(note);
    }
    nodes.push(article);
  }
  root.replaceChildren(...nodes);
}
export function renderTools(document, root, tools) {
  const nodes = tools.map(tool => {
    const item = document.createElement('pre'); item.textContent = `${tool.name} · ${tool.state}\n${tool.text || ''}`; return item;
  });
  root.replaceChildren(...nodes);
}
