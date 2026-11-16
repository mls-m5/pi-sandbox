export function createServerUpdateUI({
  document,
  getSession,
  fetchImpl = fetch,
  confirm = (message) => globalThis.confirm(message),
}) {
  const button = document.getElementById('server-update'),
    note = document.getElementById('server-update-note');
  let busy = false,
    epoch = 0,
    timer;
  const messages = {
    idle: 'Manuell uppdatering är tillgänglig i standalone via pis --server.',
    unavailable: 'Kräver standalone-server startad via pis --server från en Git-checkout.',
    checking: 'Kontrollerar checkout och offentlig GitHub-källa…',
    fetching: 'Hämtar kod…',
    validating: 'Kontrollerar kandidatens syntax…',
    activating: 'Aktiverar fast-forward…',
    restarting: 'Startar om servern. Logga in igen efter omladdning; agentarbetet fortsätter.',
    current: 'Serverkoden är redan aktuell.',
    failed:
      'Uppdateringen stoppades. Kontrollera felkoden och åtgärda på värden; ingen automatisk retry.',
  };
  function draw() {
    button.disabled = busy || !getSession();
  }
  async function poll(version, session, attempts = 0) {
    if (version !== epoch || getSession() !== session) return;
    try {
      const response = await fetchImpl('/server/update', { headers: { 'X-Pis-Web': '1' } });
      if (!response.ok) throw new Error();
      const status = await response.json();
      if (version !== epoch || getSession() !== session) return;
      const phase = Object.hasOwn(messages, status.phase) ? status.phase : 'failed';
      const code = /^update_[a-z_]{1,40}$/.test(status.error) ? ` Kod: ${status.error}.` : '';
      note.textContent = messages[phase] + code;
      if (
        ['checking', 'fetching', 'validating', 'activating', 'restarting'].includes(phase) &&
        attempts < 180
      ) {
        timer = setTimeout(() => {
          void poll(version, session, attempts + 1);
        }, 2000);
      } else {
        busy = phase === 'restarting' || attempts >= 180;
        draw();
      }
    } catch {
      if (version !== epoch) return;
      note.textContent =
        'Serveranslutningen bröts eller omstart pågår. Ladda om och logga in igen. Uppdateringsbegäran skickas inte om automatiskt.';
      busy = true;
      draw();
    }
  }
  button.addEventListener('click', async () => {
    const session = getSession();
    if (
      !session ||
      busy ||
      !confirm(
        'Hämta och kör ny serverkod från repots offentliga HTTPS GitHub-origin? Kräver ren checkout och fast-forward. Servern startas om och webbinloggningar försvinner; självständiga agentprocesser stoppas inte. Lokala utkast går förlorade om du laddar om sidan. Beroendeändringar måste installeras manuellt.',
      )
    )
      return;
    busy = true;
    const version = ++epoch;
    draw();
    try {
      const response = await fetchImpl('/server/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pis-Web': '1', 'X-CSRF-Token': session },
        body: JSON.stringify({ confirm: true }),
      });
      if (version !== epoch || getSession() !== session) return;
      if (response.status === 202) {
        void poll(version, session);
        return;
      }
      note.textContent =
        'Uppdatering kunde inte startas: endast standalone via pis --server stöds, och ingen uppdatering får redan pågå.';
      busy = false;
      draw();
    } catch {
      if (version !== epoch) return;
      note.textContent =
        'Okänt utfall. Begäran skickas inte om. Kontrollera servern innan du försöker igen.';
      draw();
    }
  });
  return {
    draw,
    clear() {
      epoch++;
      clearTimeout(timer);
      busy = false;
      note.textContent = '';
      draw();
    },
  };
}
