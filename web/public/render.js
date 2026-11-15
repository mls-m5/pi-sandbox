import { renderMarkdown } from './markdown.js';

// Content stays in textContent/fixed DOM; only Markdown's validated HTTP(S)
// links can navigate, explicitly on user click. Tool output is always literal.
export function renderActivity(document, root, status, label) {
  const state = ['working', 'waiting', 'idle', 'failed', 'offline'].includes(status) ? status : 'unknown';
  const className = `activity activity-${state}`, previous = root.children[root.children.length - 1];
  if (root.className === className && previous?.className === 'activity-label') { previous.textContent = label; return; }
  root.className = className;
  const caption = document.createElement('span'); caption.className = 'activity-label'; caption.textContent = label;
  const nodes = [];
  if (state === 'working' || state === 'waiting') {
    const spinner = document.createElement('span'); spinner.className = 'activity-spinner'; spinner.ariaHidden = 'true'; nodes.push(spinner);
  }
  root.replaceChildren(...nodes, caption);
}
function toolCard(document, tool) {
  const state = ['running', 'succeeded', 'failed'].includes(tool.state) ? tool.state : 'unknown';
  const card = document.createElement('section'); card.className = `tool-card tool-${state}`;
  const title = document.createElement('strong'); title.textContent = `Verktygsanrop: ${tool.name || 'okänt verktyg'}`;
  const status = document.createElement('div');
  renderActivity(document, status, state === 'running' ? 'working' : state === 'succeeded' ? 'idle' : state === 'failed' ? 'failed' : 'unknown',
    state === 'running' ? 'Kör…' : state === 'succeeded' ? 'Klart' : state === 'failed' ? 'Misslyckades' : 'Status okänd · resultat inte bekräftat');
  const output = document.createElement('pre'); output.textContent = tool.text || (state === 'running' ? 'Väntar på resultat…' : state === 'unknown' ? 'Inget bekräftat resultat tillgängligt.' : 'Inget textresultat.');
  card.append(title, status, output);
  if (tool.truncated) { const note = document.createElement('small'); note.textContent = '[Resultatet är förkortat eller innehåll har utelämnats]'; card.append(note); }
  return card;
}
export function renderChat(document, root, model) {
  const nodes = [], seen = new Set(), results = new Map(), calls = new Set();
  const messages = [...model.messages, ...(model.partial ? [model.partial] : [])];
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolCallId) results.set(message.toolCallId, message);
    for (const block of message.content) if (block?.type === 'tool_call' && block.id) calls.add(block.id);
  }
  const liveTools = new Map((model.tools || []).map(tool => [tool.id, tool]));
  const cardFor = (id, name, result) => {
    const live = id ? liveTools.get(id) : null;
    const state = result ? (result.isError ? 'failed' : 'succeeded') : live?.state === 'running' && (!model.stateKnown || model.status !== 'working') ? 'unknown' : live?.state;
    return toolCard(document, { name: name || result?.toolName || live?.name, state,
      truncated: result ? result.truncated || result.content.some(block => block.truncated || block.type !== 'text') : live?.truncated,
      text: result ? result.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : live?.text });
  };
  for (const message of messages) {
    if (message.role === 'toolResult') {
      const id = message.toolCallId;
      if (id && (seen.has(id) || calls.has(id))) continue;
      if (id) seen.add(id);
      nodes.push(cardFor(id, message.toolName, message)); continue;
    }
    if (message.role === 'assistant' && message.content.length && message.content.every(block => block?.type === 'tool_call') && !['error', 'aborted'].includes(message.stopReason) && !message.truncated) {
      for (const block of message.content) {
        if (block.id && seen.has(block.id)) continue;
        if (block.id) seen.add(block.id);
        nodes.push(cardFor(block.id, block.name, results.get(block.id)));
      }
      continue;
    }
    const article = document.createElement('article'); article.className = `message ${message.role === 'user' ? 'user' : 'agent'}`;
    const heading = document.createElement('strong'); heading.textContent = message.role === 'user' ? 'Du' : message.role === 'assistant' ? 'Agent' : message.role;
    article.append(heading);
    for (const block of message.content) {
      if (!block) continue;
      if (block.type === 'tool_call') {
        if (block.id && seen.has(block.id)) continue;
        if (block.id) seen.add(block.id);
        article.append(cardFor(block.id, block.name, results.get(block.id))); continue;
      }
      const pre = document.createElement('pre');
      if (block.type === 'text' && message.role === 'assistant') {
        article.append(renderMarkdown(document, block.text));
        if (block.truncated) { const note = document.createElement('small'); note.textContent = '[förkortat]'; article.append(note); }
        continue;
      } else if (block.type === 'text' || block.type === 'thinking') {
        pre.textContent = `${block.type === 'thinking' ? 'Synlig thinking: ' : ''}${block.text}${block.truncated ? '\n[förkortat]' : ''}`;
      } else pre.textContent = `[Utelämnat: ${block.kind || 'innehåll'}]`;
      article.append(pre);
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted' || message.truncated) {
      const note = document.createElement('small'); note.textContent = message.stopReason === 'error' ? 'Agenten rapporterade ett fel.' : message.stopReason === 'aborted' ? 'Avbrutet.' : 'Innehållet är förkortat.'; article.append(note);
    }
    nodes.push(article);
  }
  for (const tool of model.tools || []) if (tool.id && !seen.has(tool.id)) { nodes.push(cardFor(tool.id, tool.name)); seen.add(tool.id); }
  root.replaceChildren(...nodes);
}
export function renderTools(document, root, tools, connected = true) {
  root.replaceChildren(...tools.map(tool => toolCard(document, !connected && tool.state === 'running' ? { ...tool, state: 'unknown' } : tool)));
}
