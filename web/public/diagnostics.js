// Shared fixed codes. Do not reflect an agent's arbitrary error/message text.
const codes = new Set([
  'ok', 'duplicate', 'unknown_error', 'invalid_state_reply', 'not_connected_or_busy', 'message_too_large', 'outcome_unknown',
  'agent_offline', 'server_busy', 'protocol_rejected', 'login_required', 'authenticated',
  'pi_command_rejected', 'control_failed', 'view_detached', 'control_invalid_command', 'control_invalid_prompt',
  'control_stale_generation', 'control_id_conflict', 'control_id_limit', 'control_mutation_pending', 'control_not_idle',
  'rpc_unavailable', 'rpc_pending_limit', 'rpc_write_limit', 'rpc_timeout_ambiguous', 'rpc_response_mismatch',
  'rpc_invalid_record', 'rpc_record_too_large', 'rpc_incomplete_record', 'rpc_stdout_closed', 'rpc_stdout_error',
  'rpc_stdin_error', 'rpc_write_failed', 'rpc_process_error', 'rpc_process_closed', 'rpc_invalid_dialog',
  'rpc_dialog_cancel_failed', 'rpc_shutting_down',
]);
export const safeCode = code => codes.has(code) ? code : 'unknown_error';
export const safeTrace = trace => typeof trace === 'string' && /^(?:[a-f0-9]{12}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(trace) ? trace.replaceAll('-', '').slice(0, 12) : 'none';
export const safeAction = action => ['state', 'history', 'prompt', 'stop'].includes(action) ? action : 'unknown';
export function resultCode(result) {
  return result?.data?.duplicate === true ? 'duplicate' : result?.data?.success === true ? 'ok' : safeCode(result?.data?.error);
}
export function requestFailure(action, result) {
  const code = resultCode(result), trace = safeTrace(result?.diagnosticTrace);
  const hints = {
    not_connected_or_busy: 'Webbanslutningen är inte redo eller har för många pågående begäranden.',
    agent_offline: 'Agenten är frånkopplad. Kontrollera agentlistan och värdterminalen.',
    control_stale_generation: 'Agentens session har ändrats. Välj agenten och hämta färsk historik.',
    control_id_limit: 'Runtime har nått gränsen för kommando-ID:n. Kontrollera projektet lokalt före en avsiktlig omstart.',
    rpc_unavailable: 'Den lokala RPC-adaptern är inte tillgänglig. Kontrollera anslutningsdiagnostiken i värdterminalen.',
    pi_command_rejected: 'Pi avvisade kommandot. Råa fel döljs av säkerhetsskäl.',
    outcome_unknown: 'Ingen säker bekräftelse kom fram. Arbete spelas inte upp automatiskt.',
    rpc_timeout_ambiguous: 'Det lokala RPC-svaret nådde tidsgränsen. Arbete spelas inte upp automatiskt.',
    rpc_record_too_large: 'Ett native RPC-record överskred storleksgränsen. Ingen obunden historikhämtning tillåts.',
    invalid_state_reply: 'Tillståndssvaret saknar förväntade fält; inget ledigt tillstånd antas.',
  };
  return `${action === 'history' ? 'Kunde inte hämta historiken' : 'Kunde inte hämta agentens tillstånd'} · kod=${code} · ref=${trace}. ${hints[code] || 'Kontrollera säker diagnostik i värdterminalen.'}`;
}
export function diagnosticLine(action, result) {
  return `${safeAction(action)} · kod=${resultCode(result)} · ref=${safeTrace(result?.diagnosticTrace)}`;
}
