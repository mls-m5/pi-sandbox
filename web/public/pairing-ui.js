export function createPairingUI({ document, getSession, isSessionActive }) {
  const root = document.getElementById('pending-clients');
  const note = document.getElementById('pairing-note');
  let version = 0,
    fields = [];
  function clear() {
    version++;
    for (const field of fields) field.value = '';
    fields = [];
    root.replaceChildren();
    note.textContent = '';
  }
  function receive(value) {
    if (value?.type !== 'pending_clients') return false;
    clear();
    if (!Array.isArray(value.requests) || value.requests.length > 32) return true;
    const session = getSession(),
      epoch = version;
    for (const request of value.requests) {
      if (
        typeof request.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(request.id) ||
        typeof request.label !== 'string' ||
        request.label.length > 80 ||
        !['pi', 'dummy'].includes(request.kind)
      )
        continue;
      const form = document.createElement('form');
      const label = document.createElement('label');
      label.textContent = `${request.label} · ${request.kind} · ${request.id}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.maxLength = 2;
      input.pattern = '[0-9]{2}';
      input.required = true;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', 'Tvåsiffrig kod från klienten');
      fields.push(input);
      const button = document.createElement('button');
      button.textContent = 'Godkänn klient';
      button.disabled = false;
      label.append(input);
      form.append(label, button);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const code = input.value;
        input.value = '';
        if (
          button.disabled ||
          !/^[0-9]{2}$/.test(code) ||
          epoch !== version ||
          !isSessionActive(session)
        )
          return;
        button.disabled = true;
        try {
          const response = await fetch('/pending-clients/approve', {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/json',
              'X-Pis-Web': '1',
              'X-CSRF-Token': session,
            },
            body: JSON.stringify({ id: request.id, code }),
          });
          if (epoch === version && isSessionActive(session)) {
            if (response.status === 403) button.disabled = false;
            note.textContent = response.ok
              ? 'Klienten godkänd. Väntar på att klienten hämtar sin anslutning.'
              : 'Godkännandet nekades eller är okänt. Kontrollera klienten; inget försök skickas om automatiskt.';
          }
        } catch {
          if (epoch === version && isSessionActive(session))
            note.textContent =
              'Utfallet är okänt. Kontrollera klienten; inget försök skickas om automatiskt.';
        }
        // Only a definite rejection permits another manual attempt; never replay.
      });
      root.append(form);
    }
  }
  return { clear, receive };
}
