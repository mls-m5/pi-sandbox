const text = (value, limit = 8192) => typeof value === 'string' ? value.slice(0, limit) : '';
export function cleanMessage(source = {}) {
  const roles = ['user', 'assistant', 'toolResult', 'system', 'custom', 'branchSummary', 'compactionSummary', 'bashExecution'];
  let remaining = 16384;
  const content = [];
  for (const block of (Array.isArray(source?.content) ? source.content.slice(0, 32) : [])) {
    if (block?.type === 'text' || block?.type === 'thinking') {
      const value = text(block.text, Math.min(8192, remaining)); remaining -= value.length;
      content.push({ type: block.type, text: value, truncated: block.truncated === true || value.length < (block.text?.length || 0) });
    } else if (block?.type === 'tool_call') content.push({ type: 'tool_call', id: text(block.id, 256), name: text(block.name, 256) });
    else content.push({ type: 'omitted', kind: text(block?.kind, 32) });
  }
  const usage = {};
  if (source?.role === 'assistant') for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) if (Number.isSafeInteger(source?.usage?.[key]) && source.usage[key] >= 0) usage[key] = source.usage[key];
  return { ...(Object.keys(usage).length ? { usage } : {}), toolCallId: text(source?.toolCallId, 256), toolName: text(source?.toolName, 256), isError: source?.isError === true, role: roles.includes(source?.role) ? source.role : 'unknown', content, stopReason: text(source?.stopReason, 32), truncated: source?.truncated === true };
}
export class ChatModel {
  constructor() { this.reset(null, 0); }
  reset(generation, seq) {
    this.generation = generation; this.seq = seq; this.status = 'unknown'; this.messages = []; this.partial = null;
    this.tools = []; this.quota = ''; this.aborted = false; this.synced = false; this.stateKnown = false; this.historyLoaded = false; this.note = 'Hämtar agentens tillstånd och senaste historik…';
  }
  trim() {
    let chars = this.messages.reduce((sum, message) => sum + message.content.reduce((n, block) => n + (block.text?.length || 0), 0), 0);
    while (this.messages.length > 100 || chars > 256 * 1024) {
      const message = this.messages.shift(); chars -= message.content.reduce((n, block) => n + (block.text?.length || 0), 0);
    }
  }
  frame(frame) {
    if (frame?.generation !== this.generation || !Number.isSafeInteger(frame.seq) || frame.seq <= this.seq) return false;
    if (frame.seq !== this.seq + 1) { this.synced = false; this.stateKnown = false; this.note = 'Uppdateringar saknas. Uppdatera tillståndet eller hämta historiken igen.'; }
    if (frame.seq !== this.seq + 1 || ['runtime_fault', 'agent_settled'].includes(frame.event?.type)) {
      for (const tool of this.tools) if (tool.state === 'running') tool.state = 'unknown';
    }
    this.seq = frame.seq;
    const event = frame.event || {};
    if (event.type === 'status' && ['unknown', 'idle', 'working', 'offline'].includes(event.status)) { this.status = event.status; this.stateKnown = ['idle', 'working'].includes(event.status); }
    if (event.type === 'agent_start') { this.status = 'working'; this.stateKnown = true; this.aborted = false; }
    if (event.type === 'agent_settled') { this.status = 'idle'; this.stateKnown = true; this.aborted = event.aborted === true; }
    if (event.type === 'runtime_fault') { this.status = 'unknown'; this.stateKnown = false; this.synced = false; this.note = 'Agentens RPC behöver lokal kontroll.'; }
    if (event.type === 'dummy_status') this.quota = text(event.state, 32);
    if (event.type === 'message_start' && event.message?.role === 'assistant') this.partial = { role: 'assistant', content: [] };
    if (event.type === 'message_update') {
      const update = event.update;
      if (!update || !Number.isInteger(update.contentIndex) || update.contentIndex < 0 || update.contentIndex >= 32 || !['text_delta', 'thinking_delta', 'text_end', 'thinking_end'].includes(update.type)) return true;
      this.partial ||= { role: 'assistant', content: [] };
      const index = update.contentIndex, old = this.partial.content[index]?.text || '';
      const used = this.partial.content.reduce((sum, block, i) => sum + (i === index ? 0 : block?.text?.length || 0), 0);
      const value = update.type.endsWith('_delta') ? old + text(update.text) : text(update.text);
      this.partial.content[index] = { type: update.type.startsWith('thinking') ? 'thinking' : 'text', text: value.slice(0, Math.min(8192, 16384 - used)), truncated: value.length > Math.min(8192, 16384 - used) || update.truncated === true };
    }
    if (event.type === 'message_end') {
      const message = cleanMessage(event.message);
      if (message.role === 'assistant') this.partial = null;
      this.messages.push(message); this.trim();
    }
    if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) {
      const id = text(event.toolCallId, 256);
      let tool = this.tools.find(value => value.id === id);
      if (!tool) { tool = { id, name: text(event.toolName, 256) }; this.tools.push(tool); this.tools = this.tools.slice(-20); }
      if (event.type === 'tool_execution_start') { tool.text = ''; tool.truncated = false; tool.name = text(event.toolName, 256); }
      tool.state = event.type === 'tool_execution_end' ? (event.result?.isError === true ? 'failed' : 'succeeded') : 'running';
      if (event.result) {
        const result = cleanMessage(event.result), output = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        tool.text = output.slice(0, 2048);
        tool.truncated = result.truncated || output.length > 2048 || result.content.some(block => block.truncated || block.type !== 'text');
      }
    }
    return true;
  }
  snapshot(result) {
    if (result?.generation !== this.generation || result.stable !== true || result.endSeq !== this.seq || !Array.isArray(result.data?.history?.messages)) {
      this.synced = false; this.note = 'Historiken ändrades under hämtningen. Visar live; hämta senaste historiken igen vid behov när agenten vilar.'; return false;
    }
    this.messages = result.data.history.messages.slice(-100).map(cleanMessage); this.trim();
    if (this.status !== 'working') this.partial = null;
    this.synced = true; this.historyLoaded = true;
    this.note = result.data.history.truncated ? 'Begränsad historik: äldre innehåll eller bilagor har utelämnats.' : 'Historik hämtad från agenten.';
    return true;
  }
}
