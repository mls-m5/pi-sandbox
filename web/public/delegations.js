const labels = {
  queued: 'Köad',
  running: 'Pågår (rapporterat)',
  complete: 'Process avslutad',
  failed: 'Misslyckad',
  partial: 'Delvis/okänd',
  paused: 'Pausad',
  stopped: 'Stoppad',
  rejected: 'Avvisad',
  unknown: 'Status okänd',
};
export function createDelegationsUI({ document, getContext, refresh }) {
  const root = document.getElementById('delegations'),
    summary = document.getElementById('delegations-summary'),
    button = document.getElementById('refresh-delegations');
  let snapshot = null,
    rendered;
  button.addEventListener('click', () => {
    if (getContext().online) refresh();
  });
  function clear() {
    snapshot = null;
    rendered = undefined;
    root.replaceChildren();
    summary.textContent = 'Subagenter · okänd översikt';
  }
  function draw() {
    const context = getContext();
    button.disabled = !context.online;
    const key = JSON.stringify([snapshot, context.online, context.synchronized]);
    if (key === rendered) return;
    rendered = key;
    const nodes = [];
    let count = 0;
    function rows(values, depth) {
      for (const row of (Array.isArray(values) ? values : []).slice(0, 8)) {
        if (count >= 24 || depth > 3 || !row || typeof row !== 'object') break;
        count++;
        const card = document.createElement('section');
        card.className = 'delegation-node';
        const heading = document.createElement('strong');
        heading.textContent = `${'↳ '.repeat(depth)}${typeof row.label === 'string' ? row.label.slice(0, 128) : 'Underagent'}`;
        const state =
          row.state === 'running' && (!context.online || !context.synchronized)
            ? 'unknown'
            : typeof row.state === 'string' && Object.hasOwn(labels, row.state)
              ? row.state
              : 'unknown';
        const status = document.createElement('p');
        status.textContent = `${labels[state]}${typeof row.model === 'string' ? ` · ${row.model.slice(0, 128)}` : ''}`;
        const id = document.createElement('small');
        id.textContent = `ID: ${typeof row.id === 'string' ? row.id.slice(0, 128) : '?'}`;
        card.append(heading, status, id);
        if (typeof row.currentTool === 'string') {
          const tool = document.createElement('small');
          tool.textContent = ` · senast rapporterat verktyg: ${row.currentTool.slice(0, 128)}`;
          card.append(tool);
        }
        nodes.push(card);
        rows(row.children, depth + 1);
      }
    }
    if (snapshot) rows(snapshot.runs, 0);
    summary.textContent = snapshot
      ? `Subagenter · ${count} rapporterade noder`
      : 'Subagenter · okänd översikt';
    const note = document.createElement('p');
    note.textContent = snapshot
      ? `${count ? `Senast rapporterad ögonblicksbild${snapshot.observedAt ? ` ${new Date(snapshot.observedAt).toLocaleTimeString('sv-SE')}` : ''}.` : snapshot.omitted ? 'Rapporten saknar visningsbara noder; översikten är ofullständig.' : 'Inga asynkrona körningar rapporteras i denna ögonblicksbild.'} ${!context.online ? 'Frånkopplad; pågående status är okänd.' : ''} ${snapshot.omitted ? 'Delar har utelämnats på grund av gränser.' : ''} Process avslutad betyder inte att uppgiften är godkänd. Ingen automatisk start/styrning.`
      : 'Ingen kompatibel subagentrapport mottagen. Kräver pi-subagents RPC-widget; detta startar inga underagenter. Foreground-anrop visas fortfarande som verktygskort.';
    root.replaceChildren(note, ...nodes);
  }
  return {
    draw,
    clear,
    update(value) {
      // Bound before retaining; arbitrary peer objects are never kept as dashboard state.
      if (!value || !Array.isArray(value.runs)) {
        snapshot = null;
        draw();
        return;
      }
      let remaining = 24;
      function copy(values, depth) {
        return values.slice(0, 8).flatMap((row) => {
          if (!remaining || depth > 3 || !row || typeof row !== 'object') return [];
          remaining--;
          const result = {
            id: typeof row.id === 'string' ? row.id.slice(0, 128) : '',
            label: typeof row.label === 'string' ? row.label.slice(0, 128) : '',
            state:
              typeof row.state === 'string' && Object.hasOwn(labels, row.state)
                ? row.state
                : 'unknown',
          };
          for (const key of ['model', 'currentTool'])
            if (typeof row[key] === 'string') result[key] = row[key].slice(0, 128);
          if (Array.isArray(row.children)) result.children = copy(row.children, depth + 1);
          return [result];
        });
      }
      snapshot = {
        runs: copy(value.runs, 0),
        omitted: value.omitted === true,
        observedAt:
          Number.isSafeInteger(value.observedAt) &&
          value.observedAt > 0 &&
          value.observedAt <= 8640000000000000
            ? value.observedAt
            : null,
      };
      draw();
    },
  };
}
