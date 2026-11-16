const bytes = (value) => new TextEncoder().encode(value).length;
const validText = (value) => typeof value === 'string' && value.trim() && bytes(value) <= 64 * 1024;
const scopeOf = (context) =>
  context?.agentId && context?.generation ? `${context.agentId}:${context.generation}` : null;

// Unsaved browser drafts are separate from Pi's native queue. No delivery timer,
// persistence or replay lives here; every mutation requires a user action.
export function createMessageQueue({ document, getContext, execute }) {
  const root = document.getElementById('queued-messages'),
    note = document.getElementById('queue-note');
  let fields = [],
    entries = [],
    revision = 0,
    signature,
    epoch = 0,
    taking = false;
  const currentEntries = () => entries.filter((entry) => entry.scope === scopeOf(getContext()));
  const fits = (candidate) =>
    candidate.length <= 32 &&
    bytes(
      JSON.stringify(candidate.map(({ scope, kind, message }) => ({ scope, kind, message }))),
    ) <=
      128 * 1024;
  function append(kind, message, scope) {
    if (!scope || !['steer', 'follow_up'].includes(kind) || !validText(message)) return false;
    const next = [...entries, { id: crypto.randomUUID(), scope, kind, message, status: 'draft' }];
    if (!fits(next)) return false;
    entries = next;
    revision++;
    return true;
  }
  function add(kind, message) {
    if (!append(kind, message, scopeOf(getContext()))) {
      note.textContent =
        'Utkastet kunde inte köas: välj en agent och håll dig inom 32 meddelanden, 64 KiB/meddelande och 128 KiB totalt.';
      return false;
    }
    note.textContent = 'Lokalt utkast köat. Redigera före leverans; inget har skickats till Pi.';
    draw();
    return true;
  }
  async function send(entry) {
    const context = getContext(),
      scope = scopeOf(context),
      version = epoch;
    if (
      !entries.includes(entry) ||
      scope !== entry.scope ||
      entry.status !== 'draft' ||
      !context.ready ||
      taking
    )
      return;
    if (!validText(entry.message)) {
      note.textContent = 'Skriv ett meddelande före leverans (högst 64 KiB).';
      return;
    }
    entry.status = 'sending';
    revision++;
    draw();
    let result;
    try {
      result = await execute(context.status === 'idle' ? 'prompt' : entry.kind, {
        message: entry.message,
      });
    } catch {
      result = { data: { success: false, error: 'outcome_unknown' } };
    }
    if (version !== epoch) return;
    if (result?.data?.success === true && result.data.duplicate !== true) {
      entries = entries.filter((value) => value !== entry);
      if (scopeOf(getContext()) === scope)
        note.textContent =
          'Pi accepterade meddelandet. Det kan redan behandlas; acceptans är inte färdigt arbete.';
    } else {
      entry.status = 'unknown';
      if (scopeOf(getContext()) === scope)
        note.textContent =
          'Leverans kunde inte bekräftas. Utkastet är låst som okänt och skickas inte om. Kontrollera Pi-kö/historik innan du skriver ett nytt.';
    }
    revision++;
    draw();
  }
  async function take() {
    const context = getContext(),
      scope = scopeOf(context),
      version = epoch;
    if (
      !context.ready ||
      !scope ||
      taking ||
      entries.some((entry) => entry.status === 'sending') ||
      entries.length >= 32
    )
      return;
    if (
      !globalThis.confirm(
        'Hämta tillbaka kvarvarande steer- och uppföljningsmeddelanden från Pi? Detta tömmer hela Pi-kön. Redan levererade meddelanden kan inte tas tillbaka. Stora köer kan utelämnas; inget skickas om automatiskt.',
      )
    )
      return;
    taking = true;
    draw();
    let result;
    try {
      result = await execute('take_queue');
    } catch {
      result = { data: { success: false } };
    }
    if (version !== epoch) return;
    taking = false;
    let omitted = 0;
    if (
      result?.data?.success === true &&
      result.data.duplicate !== true &&
      Array.isArray(result.data.queue)
    ) {
      omitted =
        Number.isSafeInteger(result.data.omitted) && result.data.omitted > 0
          ? result.data.omitted
          : 0;
      for (const entry of result.data.queue.slice(0, 32))
        if (!append(entry.kind, entry.message, scope)) omitted++;
      if (result.data.queue.length > 32) omitted += result.data.queue.length - 32;
      if (scopeOf(getContext()) === scope)
        note.textContent = omitted
          ? `Pi-kön tömdes. ${omitted} meddelanden kunde inte återställas inom gränserna; kontrollera Pi. Inget skickas om.`
          : 'Kvarvarande Pi-kö hämtad som redigerbara lokala utkast. Leverera dem uttryckligen när de är klara.';
    } else if (scopeOf(getContext()) === scope)
      note.textContent =
        'Kön kunde inte hämtas säkert; utfallet kan vara okänt. Försöket skickas inte om automatiskt.';
    revision++;
    draw();
  }
  function draw() {
    const context = getContext(),
      scope = scopeOf(context);
    const key = JSON.stringify([scope, context?.ready, context?.status, taking, revision]);
    document.getElementById('clear-queue-drafts').disabled =
      taking || entries.some((entry) => entry.status === 'sending') || entries.length === 0;
    document.getElementById('take-queue').disabled =
      !context?.ready ||
      taking ||
      entries.length >= 32 ||
      entries.some((entry) => entry.status === 'sending');
    if (signature === key) return;
    signature = key;
    fields = [];
    const cards = currentEntries().map((entry) => {
      const card = document.createElement('div'),
        label = document.createElement('label'),
        field = document.createElement('textarea');
      label.textContent = `${entry.kind === 'steer' ? 'Steer' : 'Uppföljning'} · ${entry.status === 'draft' ? 'lokalt utkast' : entry.status === 'sending' ? 'leverans pågår' : 'okänt utfall – skickas inte om'}`;
      field.value = entry.message;
      fields.push(field);
      field.maxLength = 64000;
      field.readOnly = entry.status !== 'draft';
      field.addEventListener('input', () => {
        const before = entry.message;
        entry.message = field.value;
        if (bytes(entry.message) > 64 * 1024 || !fits(entries)) {
          entry.message = before;
          field.value = before;
          note.textContent = 'Textgränsen överskreds; föregående utkast behölls.';
        }
      });
      const deliver = document.createElement('button');
      deliver.type = 'button';
      deliver.textContent =
        context?.status === 'idle'
          ? 'Skicka som ny prompt'
          : entry.kind === 'steer'
            ? 'Leverera steer till Pi'
            : 'Leverera uppföljning till Pi';
      deliver.disabled = !context?.ready || taking || entry.status !== 'draft';
      deliver.addEventListener('click', () => void send(entry));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Ta bort lokalt utkast';
      remove.disabled = entry.status === 'sending';
      remove.addEventListener('click', () => {
        if (entry.status === 'sending') return;
        entries = entries.filter((value) => value !== entry);
        revision++;
        draw();
      });
      label.append(field);
      card.append(label, deliver, remove);
      return card;
    });
    root.replaceChildren(...cards);
  }
  function clear() {
    epoch++;
    for (const field of fields) field.value = '';
    fields = [];
    for (const entry of entries) entry.message = '';
    entries = [];
    taking = false;
    revision++;
    signature = undefined;
    note.textContent = '';
    root.replaceChildren();
  }
  document.getElementById('clear-queue-drafts').addEventListener('click', () => {
    if (taking || entries.some((entry) => entry.status === 'sending')) return;
    if (
      !globalThis.confirm(
        'Ta bort alla lokala utkast, även för andra agenter/äldre körningar och okända utfall? Pi-kön och redan skickade meddelanden ändras inte.',
      )
    )
      return;
    clear();
    draw();
  });
  document.getElementById('take-queue').addEventListener('click', () => void take());
  return { add, draw, clear };
}
