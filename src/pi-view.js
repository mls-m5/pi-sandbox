import { EventEmitter } from 'node:events';
import { PiControl, validateControlCommand } from './pi-rpc.js';

export const VIEW_LIMITS = Object.freeze({ textBytes: 8192, messageBytes: 16 * 1024, eventBytes: 24 * 1024, historyBytes: 256 * 1024, messages: 100, blocks: 32 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const roles = new Set(['user', 'assistant', 'toolResult', 'system', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary']);
const stopReasons = new Set(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']);

// Count serialized JSON bytes, not JS characters or only UTF-8 text bytes. Never
// stringify an unbounded source string (controls can expand sixfold in JSON).
export function viewText(value, maxBytes = VIEW_LIMITS.textBytes) {
  if (typeof value !== 'string') return { text: '', truncated: true };
  let low = 0, high = Math.min(value.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Do not split a valid surrogate pair at the truncation boundary.
  if (low < value.length && low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]) && /[\uDC00-\uDFFF]/.test(value[low])) low--;
  return { text: value.slice(0, low), truncated: low < value.length };
}
const label = value => viewText(value, 258).text;

export function projectMessage(source) {
  const message = object(source) ? source : {};
  const role = roles.has(message.role) ? message.role : 'unknown';
  const result = { role, content: [], truncated: false, omittedBlocks: 0 };
  if (Number.isSafeInteger(message.timestamp) && message.timestamp >= 0) result.timestamp = message.timestamp;
  if (stopReasons.has(message.stopReason)) result.stopReason = message.stopReason;
  if (role === 'assistant' && object(message.usage)) {
    const usage = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) if (Number.isSafeInteger(message.usage[key]) && message.usage[key] >= 0) usage[key] = message.usage[key];
    if (Object.keys(usage).length) result.usage = usage;
  }
  if (role === 'toolResult') {
    result.toolCallId = label(message.toolCallId);
    result.toolName = label(message.toolName);
    result.isError = message.isError === true;
  }
  let content = message.content;
  if (role === 'system' || role === 'unknown' || (role === 'custom' && message.display === false)) {
    result.content.push({ type: 'omitted', kind: role });
    result.omittedBlocks = 1;
    return result;
  }
  if (role === 'branchSummary' || role === 'compactionSummary') content = message.summary;
  if (role === 'bashExecution') {
    content = [{ type: 'text', text: message.command }, { type: 'text', text: message.output }];
    result.truncated = message.truncated === true;
  }
  if (typeof content === 'string') content = [{ type: 'text', text: content }];
  if (!Array.isArray(content)) content = [null];
  // Reserve enough for bounded metadata and truncation counters before admission.
  let remaining = VIEW_LIMITS.messageBytes - bytes(result) - 256;
  for (let index = 0; index < content.length; index++) {
    if (index >= VIEW_LIMITS.blocks || remaining < 256) {
      result.omittedBlocks += content.length - index;
      result.truncated = true;
      break;
    }
    const block = content[index];
    let projected;
    if (object(block) && (block.type === 'text' || (block.type === 'thinking' && block.redacted !== true))) {
      const text = viewText(block.type === 'text' ? block.text : block.thinking, Math.min(VIEW_LIMITS.textBytes, remaining - 128));
      projected = { type: block.type, ...text };
      result.truncated ||= text.truncated;
    } else if (object(block) && block.type === 'toolCall') {
      projected = { type: 'tool_call', id: label(block.id), name: label(block.name), argumentsOmitted: true };
    } else {
      projected = { type: 'omitted', kind: block?.type === 'image' ? 'image' : block?.type === 'thinking' ? 'thinking' : 'content' };
      result.omittedBlocks++;
    }
    const size = bytes(projected) + 1;
    if (size > remaining) {
      result.omittedBlocks += content.length - index;
      result.truncated = true;
      break;
    }
    result.content.push(projected);
    remaining -= size;
  }
  return result;
}

export function projectHistory(source, window) {
  const valid = Array.isArray(source);
  const messages = valid ? source : [];
  const result = { messages: [], totalMessages: messages.length, omittedMessages: 0, truncated: !valid };
  let remaining = VIEW_LIMITS.historyBytes - 1024;
  // Prefer the newest contiguous suffix; source indices are snapshot-local only.
  for (let index = messages.length - 1; index >= 0 && result.messages.length < VIEW_LIMITS.messages; index--) {
    const message = { index, ...projectMessage(messages[index]) };
    const size = bytes(message) + 1;
    if (size > remaining) break;
    result.messages.push(message);
    result.truncated ||= message.truncated || message.omittedBlocks > 0;
    remaining -= size;
  }
  result.messages.reverse();
  result.omittedMessages = messages.length - result.messages.length;
  result.truncated ||= result.omittedMessages > 0;
  if (valid && window?.truncated === true && Number.isSafeInteger(window.totalMessages) && window.totalMessages >= messages.length &&
      window.omittedMessages === window.totalMessages - messages.length && Number.isSafeInteger(window.omittedMessageBodies) && window.omittedMessageBodies >= 0 && window.omittedMessageBodies <= messages.length) {
    for (const message of result.messages) message.index += window.omittedMessages;
    result.totalMessages = window.totalMessages;
    result.omittedMessages = window.totalMessages - result.messages.length;
    result.omittedMessageBodies = window.omittedMessageBodies;
    result.truncated = true;
  }
  return result;
}

export function projectState(source) {
  const state = object(source) ? source : {};
  const result = {};
  for (const key of ['isStreaming', 'isCompacting']) if (typeof state[key] === 'boolean') result[key] = state[key];
  for (const key of ['messageCount', 'pendingMessageCount']) if (Number.isSafeInteger(state[key]) && state[key] >= 0) result[key] = state[key];
  for (const key of ['sessionId', 'sessionName', 'thinkingLevel']) if (typeof state[key] === 'string') result[key] = label(state[key]);
  if (object(state.model)) result.model = { id: label(state.model.id), name: label(state.model.name), provider: label(state.model.provider) };
  return result; // Never copy sessionFile, model baseUrl/headers, auth or arbitrary fields.
}

export function projectEvent(source) {
  if (!object(source)) return null;
  const type = source.type;
  if (type === 'dummy_status') {
    return ['waiting', 'ready', 'available', 'exhausted', 'cancelled', 'not_quota', 'wait_error'].includes(source.state)
      ? { type, state: source.state, simulated: true } : null;
  }
  if (['agent_start', 'agent_end', 'agent_settled', 'compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end', 'summarization_retry_scheduled', 'summarization_retry_attempt_start', 'summarization_retry_finished'].includes(type)) {
    const result = { type };
    for (const key of ['aborted', 'willRetry', 'success']) if (typeof source[key] === 'boolean') result[key] = source[key];
    return result; // In particular, never forward agent_end.messages or compaction details.
  }
  if (type === 'message_start' || type === 'message_end') return { type, message: projectMessage(source.message) };
  if (type === 'message_update') {
    const event = source.assistantMessageEvent;
    if (!object(event) || !Number.isSafeInteger(event.contentIndex) || event.contentIndex < 0 || event.contentIndex >= VIEW_LIMITS.blocks) return null;
    if (!['text_delta', 'thinking_delta', 'text_end', 'thinking_end', 'toolcall_start', 'toolcall_end'].includes(event.type)) return null;
    const update = { type: event.type, contentIndex: event.contentIndex };
    if (event.type.endsWith('_delta')) Object.assign(update, viewText(event.delta));
    else if (event.type === 'text_end' || event.type === 'thinking_end') Object.assign(update, viewText(event.content));
    else if (event.type === 'toolcall_start') Object.assign(update, { id: label(event.id), name: label(event.toolName), argumentsOmitted: true });
    else Object.assign(update, { id: label(event.toolCall?.id), name: label(event.toolCall?.name), argumentsOmitted: true });
    return { type, update };
  }
  if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(type)) {
    const result = { type, toolCallId: label(source.toolCallId), toolName: label(source.toolName), argumentsOmitted: true };
    if (type !== 'tool_execution_start') {
      const body = type === 'tool_execution_update' ? source.partialResult : source.result;
      result.result = projectMessage({ role: 'toolResult', toolCallId: source.toolCallId, toolName: source.toolName, content: body?.content, isError: source.isError });
    }
    return result;
  }
  if (type === 'queue_update') return { type, steeringCount: Array.isArray(source.steering) ? source.steering.length : 0, followUpCount: Array.isArray(source.followUp) ? source.followUp.length : 0 };
  // Extension notifications/widgets/dialogs are not host-authored control messages.
  // Unsupported events are dropped, not forwarded with arbitrary properties.
  return null;
}

const errors = new Set(['view_detached', 'control_invalid_command', 'control_invalid_prompt', 'control_stale_generation', 'control_id_conflict', 'control_id_limit', 'control_mutation_pending', 'control_not_idle', 'rpc_unavailable', 'rpc_pending_limit', 'rpc_write_limit', 'rpc_timeout_ambiguous', 'rpc_response_mismatch', 'rpc_invalid_record', 'rpc_record_too_large', 'rpc_history_limit', 'rpc_incomplete_record', 'rpc_stdout_closed', 'rpc_stdout_error', 'rpc_stdin_error', 'rpc_write_failed', 'rpc_process_error', 'rpc_process_closed', 'rpc_invalid_dialog', 'rpc_dialog_cancel_failed', 'rpc_shutting_down']);

// In-memory projection boundary for a future authenticated transport. No queue,
// replay, persistence, network I/O or process lifecycle control lives here.
export class PiView extends EventEmitter {
  constructor(rpc, control = new PiControl(rpc)) {
    super();
    this.rpc = rpc;
    this.control = control;
    this.sequence = 0;
    this.detached = false;
    this.onEvent = event => { const projected = projectEvent(event); if (projected) this.publish(projected); };
    this.onStatus = status => this.publish({ type: 'status', status });
    this.onDialog = ({ method }) => this.publish({ type: 'dialog_cancelled', method });
    this.onFault = () => this.publish({ type: 'runtime_fault' });
    rpc.on('event', this.onEvent);
    rpc.on('status', this.onStatus);
    rpc.on('dialog_cancelled', this.onDialog);
    rpc.on('fault', this.onFault);
  }

  publish(event) {
    this.emit('frame', { v: 1, generation: this.control.generation, seq: ++this.sequence, event });
  }

  detach() {
    this.detached = true;
    this.rpc.off('event', this.onEvent);
    this.rpc.off('status', this.onStatus);
    this.rpc.off('dialog_cancelled', this.onDialog);
    this.rpc.off('fault', this.onFault);
    // Detaching a consumer must not shut down Pi or discard control tombstones.
  }

  async execute(input) {
    const startSeq = this.sequence;
    let command, data;
    try {
      if (this.detached) throw Object.assign(new Error('view_detached'), { code: 'view_detached' });
      command = validateControlCommand(input);
      const response = await this.control.execute(command);
      if (response.duplicate === true) data = { duplicate: true };
      else if (response.success !== true) data = { success: false, error: 'pi_command_rejected' };
      else if (command.action === 'state') data = { success: true, state: projectState(response.data) };
      else if (command.action === 'history') data = { success: true, history: projectHistory(response.data?.messages, response.data?.historyWindow) };
      else if (command.action === 'prompt') {
        const disposition = response.data?.disposition;
        data = { success: true, disposition: ['started', 'queued', 'handled'].includes(disposition) ? disposition : 'unknown' };
      } else data = { success: true };
    } catch (error) {
      data = { success: false, error: errors.has(error.code) ? error.code : 'control_failed' };
    }
    return { v: 1, generation: this.control.generation, ...(command ? { id: command.id, action: command.action } : {}), startSeq, endSeq: this.sequence, stable: startSeq === this.sequence, data };
  }
}
