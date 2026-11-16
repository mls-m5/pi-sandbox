import { validateEnrollment } from './enrollment.js';
import { exact, generationValid } from './common.js';

export async function handlePairingRoute(
  req,
  res,
  {
    allowCreate,
    createRequest,
    claimRequest,
    allowApproval,
    approveRequest,
    body,
    sessionFor,
    origin,
    json,
    broadcastRoster,
  },
) {
  if (req.method === 'POST' && ['/agent/requests', '/agent/requests/result'].includes(req.url)) {
    if (req.headers.origin !== undefined || req.headers.cookie !== undefined) {
      json(res, 403, { error: 'pairing_invalid' });
      return;
    }
    const creating = req.url === '/agent/requests';
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    if ((creating && req.headers.authorization !== undefined) || (!creating && !bearer)) {
      json(res, 403, { error: 'pairing_invalid' });
      return;
    }
    if (creating && !allowCreate()) {
      json(res, 429, { error: 'pairing_limit' });
      return;
    }
    const value = await body(req);
    if (creating) {
      try {
        validateEnrollment(value);
      } catch {
        json(res, 400, { error: 'invalid_enrollment' });
        return;
      }
      const result = createRequest(value);
      json(res, result.status || 201, result.error ? { error: result.error } : result);
    } else {
      if (!exact(value, ['id']) || !generationValid(value.id)) {
        json(res, 400, { error: 'pairing_invalid' });
        return;
      }
      const result = claimRequest(value.id, bearer[1]);
      json(
        res,
        result.status || 201,
        result.error ? { error: result.error } : result.pending ? { pending: true } : result,
      );
      if (!result.error && !result.pending) broadcastRoster();
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/pending-clients/approve') {
    const session = sessionFor(req);
    if (
      !session ||
      req.headers.origin !== origin ||
      req.headers['x-csrf-token'] !== session.csrf ||
      req.headers.authorization !== undefined
    ) {
      json(res, 403, { error: 'invalid_session' });
      return;
    }
    if (!allowApproval(session.key)) {
      json(res, 429, { error: 'pairing_throttled' });
      return;
    }
    const value = await body(req);
    if (sessionFor(req)?.key !== session.key) {
      json(res, 403, { error: 'invalid_session' });
      return;
    }
    if (
      !exact(value, ['id', 'code']) ||
      !generationValid(value.id) ||
      typeof value.code !== 'string' ||
      !/^[0-9]{2}$/.test(value.code)
    ) {
      json(res, 400, { error: 'pairing_invalid' });
      return;
    }
    const result = approveRequest(value.id, value.code, session.key);
    json(res, result.status || 200, result.error ? { error: result.error } : result);
  }
}
