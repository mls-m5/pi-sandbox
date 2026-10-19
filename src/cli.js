import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Store } from './store.js';
import { validate } from './config.js';
import { CONTAINER_HOME, BASE_IMAGE, PI_VERSION, imagePlan, inspectPodman, launch, launchArgs, piCommand } from './container.js';
import { assert, directory, readJson, run, splitCommand, writeJson } from './util.js';

export const HELP = `pis — project-scoped Pi sandbox (Linux / rootless Podman)

Usage:
  pis [--project ID_OR_NAME] [--fresh] [-- PI_ARGS...]
  pis [--project ID_OR_NAME] --bash
  pis [--project ID_OR_NAME] --exec -- PROGRAM [ARGS...]
  pis --new [--name NAME]
  pis --list
  pis --relocate ID_OR_NAME
  pis [--project ID_OR_NAME] --edit | --check | --show | --build | --rebuild
  pis --doctor

By default runs pi --continue; --fresh starts without continuation.
Pi arguments belong after --. Explicit Pi session selectors override continuation.
--new registers the current directory; it does not start a conversation.
--edit uses $VISUAL, $EDITOR, or vim and saves only valid JSON configuration.
--show prints effective settings and mounts without credential values.
--rebuild disables build cache. Runtime containers are disposable.

Storage: $PIS_HOME, otherwise $XDG_DATA_HOME/pis or ~/.local/share/pis.
Never run as root. Mounted files and forwarded keys are accessible to the sandbox.
`;

export function parse(argv) {
  const separator = argv.indexOf('--');
  const wrapper = separator === -1 ? argv : argv.slice(0, separator);
  const args = separator === -1 ? [] : argv.slice(separator + 1);
  const options = { action: 'run', mode: 'pi', fresh: false, args };
  let action, mode;
  for (let i = 0; i < wrapper.length; i++) {
    const token = wrapper[i];
    const equals = token.indexOf('=');
    const key = equals === -1 ? token : token.slice(0, equals);
    if (['--project', '--name', '--relocate'].includes(key)) {
      const value = equals === -1 ? wrapper[++i] : token.slice(equals + 1);
      assert(value && !value.startsWith('-'), `${key} requires a value.`);
      if (key === '--relocate') {
        assert(!action, 'Choose only one management action.');
        action = 'relocate'; options.target = value;
      } else {
        const property = key.slice(2);
        assert(options[property] === undefined, `Repeated option: ${key}`);
        options[property] = value;
      }
    } else if (key === '--fresh' && equals === -1) {
      assert(!options.fresh, 'Repeated option: --fresh'); options.fresh = true;
    } else if (['--bash', '--exec'].includes(key) && equals === -1) {
      assert(!mode, 'Choose either --bash or --exec.'); mode = key.slice(2);
    } else if (['--new', '--list', '--edit', '--check', '--show', '--build', '--rebuild', '--doctor', '--help', '-h', '--version'].includes(key) && equals === -1) {
      assert(!action, 'Choose only one management action.'); action = key === '-h' ? 'help' : key.slice(2);
    } else throw new Error(`Unknown pis option: ${token}. Pass Pi arguments after --; see pis --help.`);
  }
  options.action = action || 'run';
  options.mode = mode || 'pi';
  assert(!options.name || action === 'new', '--name is only valid with --new.');
  assert(!mode || !action, 'Shell/exec modes cannot be combined with management actions.');
  assert(!options.fresh || (!action && !mode), '--fresh is only valid when running Pi.');
  assert(!args.length || (!action && mode !== 'bash'), 'Trailing arguments are only valid for Pi or --exec.');
  assert(mode !== 'exec' || args.length > 0, '--exec requires a command after --.');
  assert(!options.project || !['new', 'list', 'relocate', 'doctor', 'help', 'version'].includes(action), '--project is not valid with this action.');
  return options;
}

async function edit(store, original) {
  const [editor, ...editorArgs] = splitCommand(process.env.VISUAL || process.env.EDITOR || 'vim');
  const draft = path.join(store.projectDir(original.id), `edit-${randomBytes(6).toString('hex')}.json`);
  writeJson(draft, original);
  let saved = false;
  try {
    while (true) {
      const code = await run(editor, [...editorArgs, draft]);
      assert(code === 0, `Editor exited with status ${code}. Draft retained at ${draft}`);
      try {
        const candidate = readJson(draft);
        await store.save(candidate, original);
        saved = true;
        console.log(`Saved ${store.configPath(original.id)}`);
        return 0;
      } catch (error) {
        console.error(`pis: ${error.message}`);
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`Configuration was not saved. Draft retained at ${draft}`);
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        let response;
        try { response = await prompt.question('Reopen draft, discard, or keep draft? [r/d/k] '); }
        finally { prompt.close(); }
        if (response.toLowerCase() === 'r') continue;
        if (response.toLowerCase() === 'd') { fs.rmSync(draft, { force: true }); return 1; }
        throw new Error(`Configuration was not saved. Draft retained at ${draft}`);
      }
    }
  } finally {
    if (saved) fs.rmSync(draft, { force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  const options = parse(argv);
  if (options.action === 'help') { console.log(HELP); return 0; }
  if (options.action === 'version') { console.log('pis 0.1.0'); return 0; }
  assert(process.platform === 'linux', 'pis supports Linux only.');
  assert(process.getuid() !== 0, 'Run pis as your normal user, not root or sudo.');
  const store = new Store();
  const cwd = directory(process.cwd());
  if (options.action === 'doctor') {
    const info = inspectPodman();
    console.log(`Node: ${process.version}\nPodman: ${info.version.Version} (local, rootless)\nUID:GID: ${process.getuid()}:${process.getgid()}\nRuntime: ${info.host.ociRuntime?.name}\nCgroups: ${info.host.cgroupVersion}\nSELinux: ${info.host.security.selinuxEnabled ? 'enabled (shared project labels)' : 'disabled on host'}\nStorage: ${store.root}\nBase image: ${BASE_IMAGE}\nPi: ${PI_VERSION}\nRootless Podman is operational.`);
    return 0;
  }
  if (options.action === 'new') {
    const config = await store.register(cwd, options.name);
    console.log(`Registered ${config.id}${config.name ? ` (${config.name})` : ''}: ${config.root}\nConfiguration: ${store.configPath(config.id)}\nRun pis --edit to customize, then pis to start.`);
    return 0;
  }
  if (options.action === 'list') {
    const all = await store.lock(async () => { const all = store.all(); store.index(all); return all; });
    console.log(all.length ? all.map(p => `${p.id}\t${p.name || '-'}\t${p.root}${fs.existsSync(p.root) ? '' : ' [missing]'}`).join('\n') : 'No registered projects. Run pis --new in a project directory.');
    return 0;
  }
  if (options.action === 'relocate') {
    const config = await store.relocate(options.target, cwd);
    console.log(`Relocated ${config.id}: ${config.root}`);
    return 0;
  }
  const config = store.select(cwd, options.project);
  if (options.action === 'edit') return edit(store, config);
  validate(config, { storage: store.root });
  if (options.action === 'check') { console.log(`Valid: ${store.configPath(config.id)}`); return 0; }
  if (options.action === 'show') {
    const plan = imagePlan(config);
    const invocation = launchArgs(store, config, piCommand(), { cwd, image: plan.image });
    console.log(JSON.stringify({ config, configurationFile: store.configPath(config.id), image: plan.image, workingDirectory: invocation.workdir, containerHome: CONTAINER_HOME, piCommand: piCommand(), mounts: [{ source: config.root, target: config.root, access: 'read-write' }, ...config.mounts.map(m => ({ source: m.source, target: m.source, access: m.access || 'read-only' }))], credentialVariables: config.credentials.env.map(name => ({ name, present: Boolean(process.env[name]) })) }, null, 2));
    return 0;
  }
  return launch(store, config, { ...options, cwd, rebuild: options.action === 'rebuild', buildOnly: ['build', 'rebuild'].includes(options.action) });
}
