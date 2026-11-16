const phases = new Set(['pending', 'pushing', 'succeeded', 'unknown', 'declined', 'expired']);
const terminal = (phase) => ['succeeded', 'unknown', 'declined', 'expired'].includes(phase);
export function createHostPushUI({ document, getContext, send }) {
  const root = document.getElementById('host-push');
  let value,
    reviewId,
    input,
    busy = false,
    note = '',
    rendered;
  function clear() {
    if (input) input.value = '';
    value = undefined;
    reviewId = undefined;
    input = undefined;
    busy = false;
    note = '';
    rendered = undefined;
    root.replaceChildren();
  }
  function draw() {
    const context = getContext();
    if (
      !value ||
      value.agentId !== context.agentId ||
      (context.generation && context.generation !== value.generation && !terminal(value.push.phase))
    ) {
      if (input) input.value = '';
      rendered = undefined;
      root.replaceChildren();
      return;
    }
    if (!context.online && reviewId) {
      reviewId = undefined;
      if (input) input.value = '';
    }
    const key = JSON.stringify([value, reviewId, busy, note, context.online]);
    if (rendered === key) return;
    rendered = key;
    if (input) input.value = '';
    input = undefined;
    const p = value.push,
      title = document.createElement('h3');
    title.textContent =
      context.generation && context.generation !== value.generation
        ? 'Föregående körnings Git-push · endast resultat'
        : 'Godkänn Git-push · vald agents värd';
    const details = document.createElement('pre');
    details.textContent = `Repo: ${p.repo}\nRemote: ${p.remote}\nDestination: ${p.url}\nCommit: ${p.commit}\nBranch: ${p.ref}\n\nAgentens skäl (opålitligt): ${p.reason}`;
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const labels = {
      pending:
        'Sandboxen är stoppad enligt agentens värdadapter. Granska exakt destination och commit. Ingen push är godkänd ännu.',
      pushing: 'Push godkänd och begärd. Ingen automatisk retry.',
      succeeded: 'Git rapporterade lyckad push.',
      unknown:
        'Utfallet är okänt eller anslutningen bröts. Kontrollera remote på värden innan någon ny push.',
      declined: 'Avböjd. Ingen push godkändes.',
      expired: 'Godkännandet har gått ut.',
    };
    const replacement = terminal(p.phase)
      ? context.online && context.generation && context.generation !== value.generation
        ? ' Ny runtime har återanslutits. Ingen tidigare push eller prompt skickas om automatiskt.'
        : ' Väntar på agentens återanslutning. Om den förblir offline kan återstarten ha misslyckats; ingen automatisk krasch-retry görs.'
      : '';
    status.textContent = note || labels[p.phase] + replacement;
    root.replaceChildren(title, details, status);
    if (p.phase !== 'pending' || !context.online) return;
    const button = (text, handler) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.disabled = busy;
      b.addEventListener('click', handler);
      return b;
    };
    if (!reviewId) {
      root.append(
        button('Granska push', () => {
          if (
            busy ||
            value?.push.id !== p.id ||
            value.push.phase !== 'pending' ||
            !getContext().online ||
            getContext().generation !== value.generation
          )
            return;
          busy = true;
          note = 'Begär ett sessionsbundet godkännande…';
          draw();
          if (!send({ type: 'host_push_review', id: p.id })) {
            note = 'Ingen anslutning. Begäran skickas inte om.';
            draw();
          }
        }),
      );
      return;
    }
    const label = document.createElement('label');
    label.textContent = `Skriv ${p.code} för att godkänna en icke-force push`;
    input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.maxLength = 2;
    input.autocomplete = 'off';
    label.append(input);
    const decide = (approved) => {
      if (
        busy ||
        value?.push.id !== p.id ||
        value.push.phase !== 'pending' ||
        !getContext().online ||
        getContext().generation !== value.generation
      )
        return;
      const code = approved ? input.value : '';
      input.value = '';
      if (approved && !/^\d{2}$/.test(code)) {
        note = 'Ange den tvåsiffriga koden.';
        draw();
        return;
      }
      busy = true;
      note = 'Beslut skickat · inväntar värdens resultat. Skickas inte om automatiskt.';
      const fields = { type: 'host_push_decision', id: p.id, reviewId, approved, code };
      reviewId = undefined;
      draw();
      send(fields);
    };
    root.append(
      label,
      button('Godkänn push', () => decide(true)),
      button('Avböj', () => decide(false)),
    );
    const warning = document.createElement('small');
    warning.textContent =
      'Endast denna push. Inget force, ingen rekursiv submodulspush eller automatisk modellfortsättning. En ny väntande runtime återansluts efter bekräftat avslutat Git-flöde. Verifiera ett okänt utfall på värden.';
    root.append(warning);
  }
  return {
    draw,
    clear,
    receive(message) {
      const context = getContext();
      if (
        message.agentId !== context.agentId ||
        (context.generation &&
          message.generation !== context.generation &&
          !(message.type === 'host_push' && terminal(message.push?.phase)))
      )
        return;
      if (message.type === 'host_push') {
        if (
          context.generation &&
          message.generation !== context.generation &&
          value?.generation === context.generation
        )
          return;
        const p = message.push;
        if (
          !p ||
          !phases.has(p.phase) ||
          ['id', 'code', 'repo', 'remote', 'url', 'commit', 'ref', 'reason'].some(
            (key) => typeof p[key] !== 'string' || p[key].length > 2048,
          )
        )
          return;
        if (value?.push.id !== p.id || p.phase !== 'pending') {
          reviewId = undefined;
          busy = false;
          note = '';
        }
        value = {
          agentId: message.agentId,
          generation: message.generation,
          push: {
            id: p.id,
            code: p.code,
            repo: p.repo,
            remote: p.remote,
            url: p.url,
            commit: p.commit,
            ref: p.ref,
            reason: p.reason,
            phase: p.phase,
          },
        };
      } else if (
        message.type === 'host_push_review' &&
        value?.push.id === message.id &&
        value.generation === message.generation &&
        typeof message.reviewId === 'string' &&
        /^[a-f0-9-]{36}$/.test(message.reviewId)
      ) {
        reviewId = message.reviewId;
        busy = false;
        note = '';
      }
      draw();
    },
  };
}
