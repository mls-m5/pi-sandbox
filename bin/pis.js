#!/usr/bin/env node

async function start() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node.js 22.19 or newer is required; found ${process.versions.node} (${process.execPath}). Put a compatible Node on PATH, then run pis again.`);
  }
  // Check the runtime before loading modules that use newer Node built-ins.
  const { main } = await import('../src/cli.js');
  process.exitCode = await main();
}

start().catch(error => {
  console.error(`pis: ${error.message}`);
  process.exitCode = 1;
});
