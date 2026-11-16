import http from 'node:http';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { validateControlCommand } from '../src/pi-rpc.js';
import { ENROLLMENT_MS, validateEnrollment, labelValid } from './enrollment.js';
import { createAgentRegistry } from './server-registration.js';
import { createWebSessions } from './server-sessions.js';
import { startupPhase } from './public/startup.js';
import { resultCode, safeTrace } from './public/diagnostics.js';
import {
  budget,
  digest,
  exact,
  generationValid,
  idValid,
  object,
  randomKey,
  send,
  verifyPassword,
  wsOptions,
} from './common.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/activity.js', ['activity.js', 'text/javascript; charset=utf-8']],
  ['/enrollment-ui.js', ['enrollment-ui.js', 'text/javascript; charset=utf-8']],
  ['/markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']],
  ['/view-model.js', ['view-model.js', 'text/javascript; charset=utf-8']],
  ['/render.js', ['render.js', 'text/javascript; charset=utf-8']],
  ['/diagnostics.js', ['diagnostics.js', 'text/javascript; charset=utf-8']],
  ['/startup.js', ['startup.js', 'text/javascript; charset=utf-8']],
  ['/keybindings.js', ['keybindings.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const states = new Set(['unknown', 'idle', 'working', 'offline']);

export async function startWebServer({
  passwordHash,
  agents = [],
  port = 43128,
  sessionMs = 8 * 60 * 60 * 1000,
  heartbeatMs = 10_000,
  commandTimeoutMs = 35_000,
  enrollmentMs = ENROLLMENT_MS,
  diagnostic = () => {},
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(passwordHash?.salt) || !/^[a-f0-9]{128}$/.test(passwordHash?.hash))
    throw new Error('Invalid admin password hash.');
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    agents.length > 32 ||
    !Number.isSafeInteger(enrollmentMs) ||
    enrollmentMs < 1 ||
    enrollmentMs > ENROLLMENT_MS
  )
    throw new Error('Invalid local server configuration.');
  const registrations = new Map();
  for (const agent of agents) {
    if (
      !idValid(agent.id) ||
      typeof agent.label !== 'string' ||
      agent.label.length > 80 ||
      !/^[a-f0-9]{64}$/.test(agent.tokenHash) ||
      (agent.kind !== undefined && !['dummy', 'pi'].includes(agent.kind)) ||
      registrations.has(agent.id) ||
      [...registrations.values()].some((value) => value.tokenHash === agent.tokenHash)
    )
      throw new Error('Invalid agent registration.');
    registrations.set(agent.id, { ...agent, kind: agent.kind || 'dummy' });
  }
  let registry;
  const browsers = new Set(),
    connected = new Map(),
    pending = new Map();
  const loginBudget = budget(10, 60_000),
    upgradeBudget = budget(60, 60_000);
  let origin,
    hashing = 0,
    closing;
  const server = http.createServer(
    { maxHeaderSize: 8192, connectionsCheckingInterval: 1000 },
    (req, res) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent) json(res, 400, { error: 'invalid_request' });
        else res.destroy();
      });
    },
  );
  server.maxConnections = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  const wss = new WebSocketServer({ noServer: true, ...wsOptions });
  wss.on('error', () => {});
  server.on('clientError', (_error, socket) => socket.destroy());
  const sessions = createWebSessions(sessionMs, (key) => {
    registry.clearOwnerTickets(key);
    for (const ws of browsers) if (ws.sessionKey === key) ws.terminate();
  });
  const sessionFor = (req) => sessions.sessionFor(req);
  const headers = (res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${origin.replace('http:', 'ws:')}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
  };
  const json = (res, code, body) => {
    headers(res);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const validHost = (req) =>
    req.headers.host === new URL(origin).host && !req.url.includes('?') && !req.url.includes('#');
  const body = async (req) => {
    if (req.headers['content-type'] !== 'application/json' || req.headers['x-pis-web'] !== '1')
      throw new Error('Invalid body.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw new Error('Request too large.');
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  };
  const logout = (key) => sessions.logout(key);
  async function handle(req, res) {
    if (!validHost(req)) {
      json(res, 403, { error: 'invalid_host' });
      return;
    }
    if (req.method === 'POST' && req.url === '/login') {
      if (req.headers.origin !== origin) {
        json(res, 403, { error: 'invalid_origin' });
        return;
      }
      if (!loginBudget() || hashing >= 2) {
        json(res, 429, { error: 'login_throttled' });
        return;
      }
      hashing++;
      try {
        const value = await body(req);
        if (!exact(value, ['password']) || !(await verifyPassword(value.password, passwordHash))) {
          json(res, 401, { error: 'login_failed' });
          return;
        }
        sessions.expire();
        if (sessions.size >= 16) {
          json(res, 429, { error: 'session_limit' });
          return;
        }
        const { token, csrf } = sessions.issue();
        res.setHeader(
          'Set-Cookie',
          `pis_web=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(sessionMs / 1000)}`,
        );
        json(res, 200, { csrf });
      } finally {
        hashing--;
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/session') {
      const session = sessionFor(req);
      diagnostic({
        component: 'server',
        event: 'session_probe',
        code: session ? 'authenticated' : 'login_required',
      });
      json(
        res,
        session ? 200 : 401,
        session ? { csrf: session.csrf } : { error: 'login_required' },
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/logout') {
      const session = sessionFor(req);
      if (
        !session ||
        req.headers.origin !== origin ||
        req.headers['x-csrf-token'] !== session.csrf
      ) {
        json(res, 403, { error: 'invalid_session' });
        return;
      }
      await body(req);
      logout(session.key);
      res.setHeader('Set-Cookie', 'pis_web=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && req.url === '/agent/enroll') {
      const bearer =
        !req.headers.origin && !req.headers.cookie
          ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')
          : null;
      const hash = bearer ? digest(bearer[1]) : null;
      const validTicket = () => registry.validTicket(hash);
      if (!validTicket()) {
        json(res, 403, { error: 'enrollment_invalid' });
        return;
      }
      const value = await body(req);
      if (!validTicket()) {
        json(res, 403, { error: 'enrollment_invalid' });
        return;
      }
      try {
        validateEnrollment(value);
      } catch {
        json(res, 400, { error: 'invalid_enrollment' });
        return;
      }
      const enrolled = registry.enroll(hash, value);
      if (enrolled.error) {
        json(res, enrolled.status, { error: enrolled.error });
        return;
      }
      const { id, token, kind, label } = enrolled;
      json(res, 201, { id, token, kind, label });
      broadcastRoster();
      return;
    }
    if (req.method === 'GET' && req.url === '/agent/identity') {
      const registration = authenticateAgent(req);
      json(
        res,
        registration ? 200 : 403,
        registration
          ? { id: registration.id, kind: registration.kind }
          : { error: 'agent_unauthorized' },
      );
      return;
    }
    if (
      req.method === 'POST' &&
      ['/agents', '/agents/revoke', '/enrollment-keys'].includes(req.url)
    ) {
      const session = sessionFor(req);
      if (
        !session ||
        req.headers.origin !== origin ||
        req.headers['x-csrf-token'] !== session.csrf ||
        req.headers.authorization
      ) {
        json(res, 403, { error: 'invalid_session' });
        return;
      }
      const value = await body(req);
      if (req.url === '/enrollment-keys') {
        if (!exact(value, [])) {
          json(res, 400, { error: 'invalid_enrollment' });
          return;
        }
        registry.prepareTicketIssue(session.key);
        if (registry.ticketCount >= 32) {
          json(res, 429, { error: 'enrollment_limit' });
          return;
        }
        const { token, id, expiresAt } = registry.issueTicket(session.key, enrollmentMs);
        json(res, 201, { id, token, expiresAt });
        return;
      }
      if (req.url === '/agents/revoke') {
        if (!exact(value, ['id']) || !idValid(value.id)) {
          json(res, 400, { error: 'invalid_registration' });
          return;
        }
        if (!registrations.has(value.id)) {
          json(res, 404, { error: 'agent_not_found' });
          return;
        }
        revokeAgent(value.id);
        json(res, 200, { ok: true });
        return;
      }
      if (
        !exact(value, ['label', 'kind']) ||
        !labelValid(value.label) ||
        !['dummy', 'pi'].includes(value.kind)
      ) {
        json(res, 400, { error: 'invalid_registration' });
        return;
      }
      if (registrations.size >= 32) {
        json(res, 429, { error: 'agent_limit' });
        return;
      }
      const id = randomUUID(),
        token = randomKey();
      registrations.set(id, {
        id,
        label: value.label.trim(),
        kind: value.kind,
        tokenHash: digest(token),
      });
      // Only this creation response includes the plaintext. Never retain/re-list it.
      json(res, 201, { id, token, kind: value.kind });
      broadcastRoster();
      return;
    }
    if (req.method === 'GET' && assets.has(req.url)) {
      const [name, type] = assets.get(req.url);
      const text = await fs.readFile(new URL(`./public/${name}`, import.meta.url));
      headers(res);
      res.writeHead(200, { 'Content-Type': type });
      res.end(text);
      return;
    }
    json(res, 404, { error: 'not_found' });
  }
  const roster = () =>
    [...registrations.values()].map((agent) => {
      const peer = connected.get(agent.id);
      return {
        id: agent.id,
        label: agent.label,
        kind: agent.kind,
        online: Boolean(peer?.generation),
        status: peer?.status || 'offline',
        generation: peer?.generation || null,
        seq: peer?.seq || 0,
        ...(agent.startup ? { startup: agent.startup } : {}),
      };
    });
  const broadcastRoster = () => {
    for (const ws of browsers) send(ws, { v: 1, type: 'roster', agents: roster() });
  };
  const errorResult = (ws, agentId, command, error, trace = randomUUID()) => {
    diagnostic({
      component: 'server',
      event: 'command_failed',
      action: command.action,
      trace,
      code: error,
    });
    return send(ws, {
      v: 1,
      type: 'result',
      agentId,
      trace: safeTrace(trace),
      result: {
        id: command.id,
        action: command.action,
        generation: command.generation,
        data: { success: false, error },
      },
    });
  };
  function removePending(route, error) {
    const entry = pending.get(route);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(route);
    if (error) errorResult(entry.browser, entry.agentId, entry.command, error, route);
  }
  registry = createAgentRegistry({
    registrations,
    sessionExpires: (key) => sessions.get(key)?.expires,
    isConnected: (id) => connected.has(id),
    onTicketCleared: (id) => {
      for (const ws of browsers) send(ws, { v: 1, type: 'enrollment_cleared', id });
    },
  });
  const authenticateAgent = registry.authenticate;
  function revokeAgent(id) {
    const peer = connected.get(id);
    registrations.delete(id);
    connected.delete(id);
    for (const [route, entry] of pending)
      if (entry.agentId === id) removePending(route, 'outcome_unknown');
    peer?.terminate();
    broadcastRoster();
  }
  function browserMessage(ws, value) {
    if (!object(value) || value.v !== 1) throw new Error('Protocol.');
    if (
      value.type === 'select' &&
      exact(value, ['v', 'type', 'agentId', 'id']) &&
      idValid(value.id) &&
      registrations.has(value.agentId)
    ) {
      for (const [route, entry] of pending)
        if (entry.browser === ws) removePending(route, 'outcome_unknown');
      ws.selected = value.agentId;
      const peer = connected.get(value.agentId);
      send(ws, {
        v: 1,
        type: 'selected',
        id: value.id,
        agentId: value.agentId,
        generation: peer?.generation || null,
        seq: peer?.seq || 0,
        status: peer?.status || 'offline',
      });
      return;
    }
    if (
      !exact(value, ['v', 'type', 'agentId', 'command']) ||
      value.type !== 'command' ||
      value.agentId !== ws.selected
    )
      throw new Error('Protocol.');
    const command = validateControlCommand(value.command);
    const peer = connected.get(value.agentId);
    if (!peer?.generation) {
      errorResult(ws, value.agentId, command, 'agent_offline');
      return;
    }
    if (command.generation !== peer.generation) {
      errorResult(ws, value.agentId, command, 'control_stale_generation');
      return;
    }
    if (
      pending.size >= 128 ||
      [...pending.values()].filter((entry) => entry.browser === ws).length >= 8 ||
      [...pending.values()].filter((entry) => entry.agent === peer).length >= 16
    ) {
      errorResult(ws, value.agentId, command, 'server_busy');
      return;
    }
    const routeId = randomUUID();
    const entry = {
      browser: ws,
      agent: peer,
      agentId: value.agentId,
      command: { id: command.id, action: command.action, generation: command.generation },
      startedAt: Date.now(),
      timer: setTimeout(() => removePending(routeId, 'outcome_unknown'), commandTimeoutMs),
    };
    pending.set(routeId, entry);
    diagnostic({
      component: 'server',
      event: 'command_routed',
      action: command.action,
      trace: routeId,
    });
    if (!send(peer, { v: 1, type: 'command', routeId, command })) {
      removePending(routeId, 'outcome_unknown');
      return;
    }
    send(ws, {
      v: 1,
      type: 'accepted',
      agentId: value.agentId,
      id: command.id,
      trace: safeTrace(routeId),
    });
  }
  function agentMessage(ws, value) {
    if (!object(value) || value.v !== 1) throw new Error('Protocol.');
    if (!ws.generation) {
      if (
        !exact(value, ['v', 'type', 'generation', 'seq', 'status']) ||
        value.type !== 'hello' ||
        !generationValid(value.generation) ||
        !Number.isSafeInteger(value.seq) ||
        value.seq < 0 ||
        !states.has(value.status)
      )
        throw new Error('Protocol.');
      diagnostic({ component: 'server', event: 'agent_registered' });
      ws.generation = value.generation;
      ws.seq = value.seq;
      ws.status = value.status;
      const registration = registrations.get(ws.agentId);
      if (registration.startup)
        registration.startup = {
          ...registration.startup,
          phase: 'connected',
          updatedAt: Date.now(),
        };
      clearTimeout(ws.helloTimer);
      send(ws, { v: 1, type: 'registered', generation: ws.generation });
      broadcastRoster();
      return;
    }
    if (exact(value, ['v', 'type', 'frame']) && value.type === 'frame') {
      const frame = value.frame;
      if (
        !exact(frame, ['v', 'generation', 'seq', 'event']) ||
        frame.v !== 1 ||
        frame.generation !== ws.generation ||
        !Number.isSafeInteger(frame.seq) ||
        frame.seq <= ws.seq ||
        !object(frame.event) ||
        typeof frame.event.type !== 'string' ||
        frame.event.type.length > 64 ||
        Buffer.byteLength(JSON.stringify(frame)) > 24 * 1024
      )
        throw new Error('Protocol.');
      ws.seq = frame.seq;
      if (frame.event.type === 'status' && states.has(frame.event.status)) {
        ws.status = frame.event.status;
        broadcastRoster();
      }
      for (const browser of browsers)
        if (browser.selected === ws.agentId)
          send(browser, { v: 1, type: 'frame', agentId: ws.agentId, frame });
      return;
    }
    if (exact(value, ['v', 'type', 'routeId', 'result']) && value.type === 'result') {
      const entry = pending.get(value.routeId);
      if (!entry) return; // Late result is never replayed or attached to another request.
      const result = value.result;
      if (
        entry.agent !== ws ||
        !exact(result, [
          'v',
          'generation',
          'id',
          'action',
          'startSeq',
          'endSeq',
          'stable',
          'data',
        ]) ||
        result.v !== 1 ||
        result.id !== entry.command.id ||
        result.action !== entry.command.action ||
        result.generation !== ws.generation ||
        !Number.isSafeInteger(result.startSeq) ||
        result.startSeq < 0 ||
        !Number.isSafeInteger(result.endSeq) ||
        result.endSeq < result.startSeq ||
        result.stable !== (result.startSeq === result.endSeq) ||
        !object(result.data) ||
        Buffer.byteLength(JSON.stringify(result)) > 256 * 1024
      )
        throw new Error('Protocol.');
      diagnostic({
        component: 'server',
        event: 'command_result',
        action: entry.command.action,
        trace: value.routeId,
        code: resultCode(result),
        stable: result.stable,
        durationMs: Date.now() - entry.startedAt,
      });
      removePending(value.routeId);
      if (entry.browser.selected === ws.agentId)
        send(entry.browser, {
          v: 1,
          type: 'result',
          agentId: ws.agentId,
          trace: safeTrace(value.routeId),
          result,
        });
      return;
    }
    throw new Error('Protocol.');
  }
  server.on('upgrade', (req, socket, head) => {
    const refuse = (code = '403 Forbidden') =>
      socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (!validHost(req)) {
      refuse();
      return;
    }
    if (!upgradeBudget()) {
      refuse('429 Too Many Requests');
      return;
    }
    let session, registration;
    if (
      req.url === '/browser' &&
      req.headers.origin === origin &&
      !req.headers.authorization &&
      browsers.size < 8
    )
      session = sessionFor(req);
    else if (req.url === '/agent') registration = authenticateAgent(req);
    if (!session && !registration) {
      refuse();
      return;
    }
    if (registration && connected.has(registration.id)) {
      refuse('409 Conflict');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.alive = true;
      const receiveBudget = budget(registration ? 500 : 30, 1000);
      ws.on('error', () => {});
      ws.on('pong', () => {
        if (!receiveBudget()) ws.terminate();
        else ws.alive = true;
      });
      ws.on('ping', () => {
        if (!receiveBudget()) ws.terminate();
      });
      if (registration) {
        ws.agentId = registration.id;
        ws.status = 'unknown';
        connected.set(registration.id, ws);
        ws.helloTimer = setTimeout(() => ws.terminate(), 5000);
      } else {
        diagnostic({ component: 'server', event: 'browser_connected' });
        ws.sessionKey = session.key;
        browsers.add(ws);
        send(ws, { v: 1, type: 'roster', agents: roster() });
      }
      ws.on('message', (data, binary) => {
        try {
          if (
            binary ||
            !receiveBudget() ||
            (registration && !registrations.has(ws.agentId)) ||
            (!registration &&
              (!sessions.has(ws.sessionKey) || sessions.get(ws.sessionKey).expires <= Date.now()))
          )
            throw new Error('Protocol.');
          const value = JSON.parse(data.toString());
          if (registration) agentMessage(ws, value);
          else browserMessage(ws, value);
        } catch {
          diagnostic({
            component: 'server',
            event: 'protocol_rejected',
            code: 'protocol_rejected',
          });
          ws.terminate();
        }
      });
      ws.on('close', () => {
        diagnostic({
          component: 'server',
          event: registration ? 'agent_disconnected' : 'browser_disconnected',
        });
        clearTimeout(ws.helloTimer);
        browsers.delete(ws);
        if (registration && connected.get(registration.id) === ws) {
          connected.delete(registration.id);
          broadcastRoster();
        }
        for (const [route, entry] of pending) {
          if (entry.agent === ws) removePending(route, 'outcome_unknown');
          else if (entry.browser === ws) {
            diagnostic({
              component: 'server',
              event: 'command_failed',
              action: entry.command.action,
              trace: route,
              code: 'outcome_unknown',
            });
            removePending(route);
          }
        }
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  server.on('error', () => {});
  origin = `http://127.0.0.1:${server.address().port}`;
  const heartbeat = setInterval(() => {
    sessions.expire();
    registry.expireTickets();
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, heartbeatMs);
  return {
    origin,
    roster,
    setStartup(id, phase) {
      if (!startupPhase(phase) || !registrations.has(id))
        throw new Error('Invalid host startup phase.');
      const agent = registrations.get(id),
        now = Date.now();
      agent.startup = { phase, startedAt: agent.startup?.startedAt || now, updatedAt: now };
      broadcastRoster();
    },
    revokeAgent,
    close() {
      return (closing ||= (async () => {
        clearInterval(heartbeat);
        for (const route of pending.keys()) removePending(route, 'outcome_unknown');
        for (const ws of wss.clients) ws.terminate();
        await new Promise((resolve) => wss.close(resolve));
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        sessions.clear();
        registrations.clear();
        connected.clear();
        registry.clearTickets();
      })());
    },
  };
}
