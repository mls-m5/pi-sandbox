// Transport preferences are not HTTP origins. Only the resolved loopback origin
// crosses the existing enrollment/control protocol.
export function serverAddress(value) {
  const invalid = () => {
    throw new Error(
      'Invalid server address. Use http://127.0.0.1:43128 or ssh://[USER@]HOST[:SSH_PORT][/PIS_PORT].',
    );
  };
  if (typeof value !== 'string' || value.length > 256 || /[\s\x00-\x1f\x7f%\\]/.test(value))
    return invalid();
  let url;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.password || url.search || url.hash) return invalid();
  if (url.protocol === 'http:') {
    if (url.hostname !== '127.0.0.1' || url.username || url.pathname !== '/') return invalid();
    return { address: url.origin, origin: url.origin, kind: 'local' };
  }
  if (
    url.protocol !== 'ssh:' ||
    !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])$/.test(url.hostname) ||
    (url.username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(url.username)) ||
    !/^\/(?:[0-9]{1,5})?$/.test(url.pathname || '/')
  )
    return invalid();
  const sshPort = url.port ? Number(url.port) : 22;
  const serverPort = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 43128;
  if (![sshPort, serverPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535))
    return invalid();
  const address = `ssh://${url.username ? `${url.username}@` : ''}${url.hostname}${sshPort === 22 ? '' : `:${sshPort}`}${serverPort === 43128 ? '' : `/${serverPort}`}`;
  return {
    address,
    origin: `http://127.0.0.1:${serverPort}`,
    kind: 'ssh',
    host: url.hostname.replace(/^\[|\]$/g, ''),
    user: url.username || undefined,
    sshPort,
    serverPort,
  };
}
