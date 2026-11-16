const byId = (document, id) => document.getElementById(id);

export function createEnrollmentUI({
  document,
  isConnected,
  isSessionActive,
  getSession,
  getSelected,
  draw,
}) {
  let registering = false;
  let enrollmentId;
  let enrollmentTimer;
  let enrollmentVersion = 0;

  function clear() {
    enrollmentVersion++;
    enrollmentId = undefined;
    clearTimeout(enrollmentTimer);
    byId(document, 'registration-secret').value = '';
    byId(document, 'registration-secret-label').hidden = true;
    byId(document, 'clear-registration').hidden = true;
  }

  async function registrationRequest(path, value) {
    const result = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pis-Web': '1',
        'X-CSRF-Token': getSession(),
      },
      body: JSON.stringify(value),
      cache: 'no-store',
      redirect: 'error',
    });
    if (!result.ok) throw new Error('registration_failed');
    return result.json();
  }

  async function issue(event) {
    event.preventDefault();
    if (registering || !isConnected()) return;
    clear();
    registering = true;
    const session = getSession();
    const version = enrollmentVersion;
    draw();
    try {
      const value = await registrationRequest('/enrollment-keys', {});
      if (!isSessionActive(session) || version !== enrollmentVersion) return;
      enrollmentId = value.id;
      enrollmentTimer = setTimeout(
        () => {
          clear();
          byId(document, 'register-note').textContent =
            'Engångsnyckeln har upphört att gälla. Skapa en ny.';
        },
        Math.max(0, Math.min(600000, value.expiresAt - Date.now())),
      );
      byId(document, 'registration-secret').value = value.token;
      byId(document, 'registration-secret-label').hidden = false;
      byId(document, 'clear-registration').hidden = false;
      byId(document, 'register-note').textContent =
        'Kopiera engångsnyckeln till den dolda frågan i pis --connect. Den byts mot en privat anslutningsnyckel och kan bara användas en gång. Servern får kontroll över ansluten agent; välj rätt server och projekt.';
    } catch {
      byId(document, 'register-note').textContent =
        'Engångsnyckeln kunde inte skapas eller visas. Försök skapa en ny; det skapar ingen agentpost.';
    } finally {
      registering = false;
      draw();
    }
  }

  async function revoke() {
    const id = getSelected();
    if (
      !id ||
      !globalThis.confirm(
        'Återkalla vald agents anslutningsnyckel? Agentprocessen stoppas inte, men webbanslutningen stängs.',
      )
    )
      return;
    clear();
    try {
      await registrationRequest('/agents/revoke', { id });
      byId(document, 'registration-action').textContent =
        'Nyckeln är återkallad. Agenten kan fortfarande arbeta lokalt; den stoppades inte.';
    } catch {
      byId(document, 'registration-action').textContent =
        'Återkallelsen kunde inte bekräftas. Kontrollera agentlistan.';
    }
  }

  function receive(value) {
    if (value?.type !== 'enrollment_cleared') return false;
    if (value.id === enrollmentId) {
      clear();
      byId(document, 'register-note').textContent =
        'Engångsnyckeln har använts eller upphört att gälla.';
    }
    return true;
  }

  function bind() {
    byId(document, 'register-agent').addEventListener('submit', issue);
    byId(document, 'clear-registration').addEventListener('click', clear);
    byId(document, 'revoke-agent').addEventListener('click', () => void revoke());
  }

  return { bind, clear, isRegistering: () => registering, receive };
}
