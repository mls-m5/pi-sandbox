import { ChatModel } from './view-model.js';
import { renderChat, renderTools } from './render.js';
import { handlePromptKey } from './keybindings.js';
import { startupText, startupFailure } from './startup.js';
import { diagnosticLine, requestFailure, resultCode, safeTrace } from './diagnostics.js';

const byId = id => document.getElementById(id);
const model = new ChatModel(), pending = new Map(), diagnosticLines = [];
let socket, csrf, agents = [], selected, selectToken, selection = 0, connected = false, wantConnection = false;
let reconnectTimer, retry = 0, syncTimer, syncing = false, syncAttempts = 0, mutation = false, drawing = false;
const online = () => connected && agents.some(agent => agent.id === selected && agent.online && agent.generation === model.generation);
function draw() {
  if (drawing) return;
  drawing = true;
  requestAnimationFrame(() => {
    drawing = false;
    byId('diagnostics').textContent = diagnosticLines.join('\n') || 'Inga läsbegäranden ännu. Diagnostiken innehåller bara kommando, felkod och referens.';
    byId('connection').textContent = connected ? 'Ansluten till lokal server' : 'Frånkopplad · inga meddelanden skickas om';
    const selectedAgent = agents.find(agent => agent.id === selected);
    byId('agent-title').textContent = selectedAgent?.label || 'Välj en agent';
    byId('mode-note').textContent = agents.some(agent => agent.kind === 'pi') ? 'Riktiga Pi-projekt · modell-anrop kan kosta · inga värdgodkännanden' : 'Bara dummy · inga modelltokens · inga värdgodkännanden';
    byId('prompt').placeholder = selectedAgent?.kind === 'pi' ? 'Skriv till Pi i sandboxen…' : 'Skriv till dummy-agenten…';
    for (const id of ['quota', 'refill']) byId(id).hidden = selectedAgent?.kind !== 'dummy';
    const starting = !selectedAgent?.online ? startupText(selectedAgent?.startup) : '';
    byId('state').textContent = starting || `${model.status}${model.quota ? ` · dummy-kvot: ${model.quota}` : ''}`;
    byId('sync-note').textContent = starting ? (startupFailure(selectedAgent?.startup?.phase)
      ? 'Projektstarten misslyckades, men webbservern är igång. Kontrollera orsaken på värden; ingen automatisk omstart sker.'
      : 'Webbservern är igång. Agenten kan inte ta emot meddelanden förrän Pi och anslutningen är klara.') : model.note;
    const ready = online() && model.status === 'idle' && model.stateKnown && !mutation;
    for (const id of ['send', 'quota', 'refill']) byId(id).disabled = !ready;
    byId('stop').disabled = !online() || mutation;
    byId('refresh').disabled = !online() || syncing;
    const buttons = agents.map(agent => {
      const button = document.createElement('button'); button.type = 'button'; button.className = `agent-button${agent.id === selected ? ' selected' : ''}`;
      button.textContent = `${agent.label}\n${agent.online ? agent.status : startupText(agent.startup) || 'offline'} · ${agent.kind}`;
      button.addEventListener('click', () => choose(agent.id)); return button;
    });
    byId('agents').replaceChildren(...buttons);
    const root = byId('messages'), bottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
    renderChat(document, root, model); renderTools(document, byId('tools'), model.tools);
    if (bottom) root.scrollTop = root.scrollHeight;
  });
}
function command(action, extra = {}) {
  const id = crypto.randomUUID(), agentId = selected;
  const finish = result => {
    const annotated = { ...result, diagnosticTrace: safeTrace(result?.diagnosticTrace || id) };
    diagnosticLines.push(diagnosticLine(action, annotated));
    if (diagnosticLines.length > 20) diagnosticLines.shift();
    draw(); return annotated;
  };
  if (!online() || pending.size >= 8 || socket.bufferedAmount > 128 * 1024) return Promise.resolve(finish({ data: { success: false, error: 'not_connected_or_busy' } }));
  const message = { v: 1, type: 'command', agentId, command: { v: 1, generation: model.generation, id, action, ...extra } };
  const payload = JSON.stringify(message);
  if (new TextEncoder().encode(payload).length > 256 * 1024) return Promise.resolve(finish({ data: { success: false, error: 'message_too_large' } }));
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      const trace = pending.get(id)?.diagnosticTrace; pending.delete(id);
      resolve({ diagnosticTrace: trace, data: { success: false, error: 'outcome_unknown' } });
    }, 40_000);
    pending.set(id, { agentId, resolve, timer });
    try { socket.send(payload); }
    catch { clearTimeout(timer); pending.delete(id); resolve({ data: { success: false, error: 'outcome_unknown' } }); }
  }).then(finish);
}
function failPending() {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve({ diagnosticTrace: entry.diagnosticTrace, data: { success: false, error: 'outcome_unknown' } }); }
  pending.clear();
}
function scheduleSync() {
  clearTimeout(syncTimer);
  if (syncAttempts < 3) syncTimer = setTimeout(() => { void synchronize(); }, 200);
}
async function synchronize({ history: loadHistory = false } = {}) {
  if (!online() || syncing) return;
  const version = selection;
  syncing = true; syncAttempts++; draw();
  try {
    const state = await command('state');
    if (version !== selection) return;
    if (state.data?.success !== true) { model.stateKnown = false; model.synced = false; model.status = 'unknown'; model.note = requestFailure('state', state); return; }
    const value = state.data.state;
    if (typeof value?.isStreaming !== 'boolean' || typeof value?.isCompacting !== 'boolean' || !Number.isSafeInteger(value?.pendingMessageCount) || value.pendingMessageCount < 0) {
      model.stateKnown = false; model.synced = false; model.status = 'unknown';
      const invalid = { ...state, data: { success: false, error: 'invalid_state_reply' } };
      diagnosticLines.push(diagnosticLine('state', invalid)); diagnosticLines.splice(0, Math.max(0, diagnosticLines.length - 20));
      model.note = requestFailure('state', invalid); return;
    }
    if (state.stable === true && state.endSeq === model.seq) {
      model.status = value.isStreaming || value.isCompacting || value.pendingMessageCount > 0 ? 'working' : 'idle';
      model.stateKnown = true;
    } else if (!loadHistory) {
      model.note = 'Tillståndet ändrades under kontrollen. Visar live; kontrollera igen vid behov.';
      return;
    }
    if (!loadHistory) {
      model.note = model.historyLoaded ? 'Livevy redo. Hämtad historik är en begränsad ögonblicksbild; läs igen vid behov.' : 'Livevy redo. Historik saknas; välj Hämta senaste historik för att försöka igen.';
      return;
    }
    model.note = 'Hämtar senaste historik. Livehändelser visas under tiden…'; draw();
    const history = await command('history');
    if (version !== selection) return;
    if (history.data?.success !== true) {
      model.synced = false;
      model.note = resultCode(history) === 'rpc_history_limit' ? 'Historiken överskred läsgränsen och utelämnades. Livevy och agentkontroll fortsätter; sparad session är orörd.' : requestFailure('history', history);
      return;
    }
    model.snapshot(history);
  } finally { if (version === selection) { syncing = false; draw(); } }
}
function choose(id) {
  if (!connected) return;
  failPending(); selected = id; selectToken = crypto.randomUUID(); selection++; syncing = false; syncAttempts = 0; mutation = false;
  clearTimeout(syncTimer); model.reset(null, 0);
  byId('command-note').textContent = '';
  socket.send(JSON.stringify({ v: 1, type: 'select', agentId: id, id: selectToken })); draw();
}
async function submit(message, clearDraft = false) {
  if (!online() || model.status !== 'idle' || !model.stateKnown || mutation || !message.trim()) return;
  const version = selection;
  mutation = true; draw();
  const result = await command('prompt', { message });
  if (version !== selection) return;
  mutation = false;
  if (result.data?.success === true) {
    byId('command-note').textContent = 'Meddelandet accepterades av agenten. Det betyder inte att arbetet är slutfört.';
    if (clearDraft && byId('prompt').value === message) byId('prompt').value = '';
    if (result.data.disposition === 'handled') { syncAttempts = 0; scheduleSync(); }
  } else byId('command-note').textContent = result.data?.duplicate ? 'Redan sett kommando. Hämta historiken; skicka inte om automatiskt.' : `Ingen automatisk omsändning. Resultat: ${resultCode(result)}. Hämta historiken innan du försöker igen.`;
  draw();
}
function receive(value) {
  if (value?.v !== 1) return;
  if (value.type === 'roster' && Array.isArray(value.agents)) {
    const previous = agents.find(agent => agent.id === selected);
    agents = value.agents.slice(0, 32);
    const current = agents.find(agent => agent.id === selected);
    if (selected && !current) { failPending(); selected = undefined; selection++; syncing = false; clearTimeout(syncTimer); model.reset(null, 0); }
    if (!selected && agents.length) choose(agents[0].id);
    else if (current?.online && (!previous?.online || current.generation !== model.generation)) choose(current.id);
    else if (current && !current.online) { model.status = 'offline'; model.stateKnown = false; model.synced = false; model.note = 'Agenten är offline. Pågående arbete kan ha fortsatt; inget skickas om.'; }
    draw(); return;
  }
  if (value.agentId !== selected) return;
  if (value.type === 'selected') {
    if (value.id !== selectToken) return;
    model.reset(value.generation, value.seq); model.status = value.status;
    if (value.generation) void synchronize({ history: true }); else { model.note = 'Agenten är offline.'; draw(); }
  } else if (value.type === 'frame') {
    if (model.frame(value.frame)) {
      if (value.frame.event?.type === 'agent_start') syncAttempts = 0;
      if (value.frame.event?.type === 'agent_settled') scheduleSync();
      draw();
    }
  } else if (value.type === 'accepted') {
    const entry = pending.get(value.id);
    if (entry?.agentId === value.agentId) entry.diagnosticTrace = safeTrace(value.trace);
  } else if (value.type === 'result') {
    const entry = pending.get(value.result?.id);
    if (entry?.agentId === value.agentId) { clearTimeout(entry.timer); pending.delete(value.result.id); entry.resolve({ ...value.result, diagnosticTrace: safeTrace(value.trace) }); }
  }
}
async function connect() {
  if (!wantConnection) return;
  try {
    const session = await fetch('/session', { cache: 'no-store' });
    if (!session.ok) { showLogin(); return; }
    csrf = (await session.json()).csrf;
    if (!wantConnection) return;
    socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/browser`);
    const ws = socket;
    ws.onopen = () => { if (ws !== socket) return; retry = 0; connected = true; agents = []; draw(); };
    ws.onmessage = event => { if (ws === socket) { try { receive(JSON.parse(event.data)); } catch { ws.close(); } } };
    ws.onclose = () => {
      if (ws !== socket) return;
      connected = false; model.status = 'unknown'; model.stateKnown = false; model.synced = false; model.note = 'Frånkopplad. Tillstånd och senaste historik hämtas efter återanslutning; inget meddelande skickas om.';
      failPending(); draw(); retryConnect();
    };
    ws.onerror = () => {};
  } catch { connected = false; draw(); retryConnect(); }
}
function retryConnect() {
  clearTimeout(reconnectTimer);
  if (wantConnection) reconnectTimer = setTimeout(() => { void connect(); }, Math.min(10_000, 500 * 2 ** Math.min(retry++, 5)) + Math.random() * 200);
}
function showLogin() {
  wantConnection = false; connected = false; clearTimeout(reconnectTimer); clearTimeout(syncTimer);
  socket?.close(); failPending(); selected = undefined; selection++; model.reset(null, 0);
  byId('workspace').hidden = true; byId('logout').hidden = true; byId('login').hidden = false;
}
function showWorkspace() {
  byId('login').hidden = true; byId('workspace').hidden = false; byId('logout').hidden = false;
  wantConnection = true; void connect();
}
byId('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = byId('password').value; byId('password').value = '';
  try {
    const result = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pis-Web': '1' }, body: JSON.stringify({ password }) });
    if (!result.ok) { byId('login-note').textContent = result.status === 429 ? 'För många försök. Vänta en minut.' : 'Inloggningen misslyckades.'; return; }
    csrf = (await result.json()).csrf; byId('login-note').textContent = ''; showWorkspace();
  } catch { byId('login-note').textContent = 'Servern kunde inte nås.'; }
});
byId('logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pis-Web': '1', 'X-CSRF-Token': csrf }, body: '{}' });
    if (response.ok) { showLogin(); return; }
  } catch { /* Do not claim the server invalidated a session without confirmation. */ }
  byId('command-note').textContent = 'Utloggningen kunde inte bekräftas. Försök igen eller stäng den lokala servern.';
});
byId('prompt-form').addEventListener('submit', event => { event.preventDefault(); void submit(byId('prompt').value, true); });
byId('prompt').addEventListener('keydown', event => { handlePromptKey(event, () => { void submit(byId('prompt').value, true); }); });
byId('quota').addEventListener('click', () => { void submit('/dummy quota 5'); });
byId('refill').addEventListener('click', () => { void submit('/dummy refill'); });
byId('refresh').addEventListener('click', () => { syncAttempts = 0; void synchronize({ history: true }); });
byId('stop').addEventListener('click', async () => {
  if (!online() || mutation) return;
  const version = selection; mutation = true; draw();
  const result = await command('stop');
  if (version !== selection) return;
  mutation = false; byId('command-note').textContent = result.data?.success ? 'Stoppbegäran hanterad. Kontrollerar tillståndet.' : 'Stoppets utfall är okänt. Kontrollera agenten; inget spelas upp igen.';
  syncAttempts = 0; void synchronize(); draw();
});
const startupTick = setInterval(() => { if (connected && agents.some(agent => !agent.online && agent.startup)) draw(); }, 1000);
globalThis.addEventListener('pagehide', () => {
  clearInterval(startupTick);
  wantConnection = false; selection++; clearTimeout(reconnectTimer); clearTimeout(syncTimer); socket?.close(); failPending();
});
fetch('/session', { cache: 'no-store' }).then(response => { if (response.ok) showWorkspace(); }).catch(() => {});
