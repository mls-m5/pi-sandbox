// Optional installed-Pi probe: no prompt/tool execution, only synthetic memory state.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [pkg, cwd, helper, bootstrap] = process.argv.slice(2);
const { createAgentSession, SessionManager, SettingsManager, ModelRuntime } = await import(pathToFileURL(path.join(pkg, 'dist/index.js')));
const { loadExtensions } = await import(pathToFileURL(path.join(pkg, 'dist/core/extensions/loader.js')));
const { imageCommand } = await import(pathToFileURL(bootstrap));
const result = [];
for (const mode of ['fresh', 'removed-baseline', 'restored-optin', 'explicit-selection', 'explicit-none', 'explicit-exclusion']) {
  const loaded = await loadExtensions([helper], cwd);
  if (loaded.errors.length) throw new Error('probe_extension_load_failed');
  const definition = loaded.extensions[0].tools.get('request_host_git').definition;
  const declaration = { name: definition.name, description: definition.description, parameters: definition.parameters };
  const manager = SessionManager.inMemory(cwd);
  if (mode !== 'fresh') {
    manager.appendMessage({ role: 'system', content: 'Synthetic old loadout', toolsAdded: [declaration, { name: 'read', description: 'Synthetic existing tool', parameters: { type: 'object', properties: {} } }], timestamp: 1 });
    manager.appendMessage({ role: 'system', content: 'Synthetic removed host tool', toolsRemoved: [declaration], timestamp: 2 });
  }
  const explicit = mode === 'explicit-selection' ? ['--tools', 'read'] : mode === 'explicit-none' ? ['--no-tools'] : mode === 'explicit-exclusion' ? ['--exclude-tools', 'request_host_git'] : [];
  const command = imageCommand(['pi', '--mode', 'rpc', ...explicit], [], { PIS_APT_SOCKET: '/nonexistent-pis-probe', ...(mode !== 'removed-baseline' ? { PIS_HOST_GIT_ONLY: '1' } : {}) });
  const selection = command.indexOf('--tools'), excluded = command.indexOf('--exclude-tools');
  const resourceLoader = {
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => 'Offline probe only.', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
  };
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: path.join(cwd, 'models.json') });
  const { session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader, sessionManager: manager, settingsManager: SettingsManager.inMemory(), modelRuntime,
    ...(selection >= 0 ? { tools: command[selection + 1].split(',') } : {}),
    ...(command.includes('--no-tools') ? { noTools: 'all' } : {}),
    ...(excluded >= 0 ? { excludeTools: command[excluded + 1].split(',') } : {}),
  });
  try { result.push({ mode, registered: session.getAllTools().some(tool => tool.name === 'request_host_git'), active: session.getActiveToolNames().includes('request_host_git'), read: session.getActiveToolNames().includes('read') }); }
  finally { session.dispose(); }
}
console.log(JSON.stringify(result));
