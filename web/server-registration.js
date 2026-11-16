import { randomUUID, timingSafeEqual } from 'node:crypto';
import { digest, randomKey } from './common.js';
import { uniqueAgentLabel } from './enrollment.js';

/** Owns bearer registrations and the one-use ticket lifecycle for the server. */
export function createAgentRegistry({
  registrations,
  sessionExpires,
  isConnected,
  onTicketCleared,
}) {
  const tickets = new Map();

  function clearTicket(hash) {
    const ticket = tickets.get(hash);
    if (!ticket) return;
    tickets.delete(hash);
    onTicketCleared(ticket.id);
  }

  return {
    get ticketCount() {
      return tickets.size;
    },
    clearOwnerTickets(owner) {
      for (const [hash, ticket] of tickets) if (ticket.owner === owner) clearTicket(hash);
    },
    prepareTicketIssue(owner) {
      for (const [hash, ticket] of tickets)
        if (ticket.expires <= Date.now() || ticket.owner === owner) clearTicket(hash);
    },
    issueTicket(owner, lifetime) {
      const token = randomKey();
      const id = randomUUID();
      const expiresAt = Date.now() + lifetime;
      tickets.set(digest(token), { id, owner, expires: expiresAt });
      return { token, id, expiresAt };
    },
    expireTickets() {
      for (const [hash, ticket] of tickets) if (ticket.expires <= Date.now()) clearTicket(hash);
    },
    clearTickets() {
      tickets.clear();
    },
    validTicket(hash) {
      const ticket = tickets.get(hash);
      return Boolean(
        ticket && ticket.expires > Date.now() && (sessionExpires(ticket.owner) || 0) > Date.now(),
      );
    },
    enroll(hash, value) {
      const proof = value.previousToken ? digest(value.previousToken) : null;
      const proofMatches = (agent) =>
        proof && timingSafeEqual(Buffer.from(agent.tokenHash, 'hex'), Buffer.from(proof, 'hex'));
      let existing = [...registrations.values()].find((agent) => agent.clientId === value.clientId);
      if (!existing && proof)
        existing = [...registrations.values()].find(
          (agent) => !agent.clientId && proofMatches(agent),
        );
      if (
        existing &&
        (!proofMatches(existing) || existing.kind !== value.kind || isConnected(existing.id))
      )
        return { status: 409, error: 'enrollment_conflict' };
      if (!existing && registrations.size >= 32) return { status: 429, error: 'agent_limit' };
      const id = existing?.id || randomUUID();
      const token = randomKey();
      const kind = value.kind;
      const label = uniqueAgentLabel(registrations, value.label, id);
      registrations.set(id, {
        id,
        label,
        kind,
        clientId: value.clientId,
        tokenHash: digest(token),
      });
      clearTicket(hash); // No asynchronous work occurs between revalidation and consume.
      return { id, token, kind, label };
    },
    authenticate(req) {
      if (req.headers.origin || req.headers.cookie) return;
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
      if (!match) return;
      const hash = Buffer.from(digest(match[1]), 'hex');
      for (const candidate of registrations.values())
        if (timingSafeEqual(hash, Buffer.from(candidate.tokenHash, 'hex'))) return candidate;
    },
  };
}
