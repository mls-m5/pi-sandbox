// Pure display policy. Runtime lifecycle and control readiness stay in the model
// and app; idle here is explicitly not proof that the task succeeded.
const labels = {
  working: 'Agenten arbetar…',
  idle: 'Agenten är inaktiv · kontrollera resultatet',
  failed: 'Agenten rapporterade ett fel · kontrollera resultatet',
  offline: 'Agenten är offline · utfallet är okänt',
  unknown: 'Agentens tillstånd är okänt',
};

export function describeActivity(model, { online, starting = '', startupFailed = false }) {
  const result = (state, label = labels[state] || labels.unknown) => ({
    state,
    label: `${label}${model.quota ? ` · dummy-kvot: ${model.quota}` : ''}`,
  });
  if (starting) return result(startupFailed ? 'failed' : 'working', starting);
  if (!online) return result('offline');
  if (model.quota === 'waiting') return result('waiting', 'Väntar på dummy-kvot · inte färdig');

  const lastReply = model.messages.findLast((message) => message.role === 'assistant');
  const aborted = model.status === 'idle' && (model.aborted || lastReply?.stopReason === 'aborted');
  if (!model.stateKnown || aborted)
    return result('unknown', aborted ? 'Avbruten · inget lyckat avslut bekräftat' : labels.unknown);
  if (model.status === 'idle' && lastReply?.stopReason === 'error') return result('failed');
  return result(model.status);
}
