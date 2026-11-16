// Build-only. Runs in a credential-free image build, never on the host.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function verifyPackedArtifact(file, integrity) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 128 * 1024 * 1024 ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
  )
    throw new Error('Invalid release artifact.');
  if (`sha512-${createHash('sha512').update(fs.readFileSync(file)).digest('base64')}` !== integrity)
    throw new Error('Release artifact integrity mismatch.');
}

export function installRelease({
  root = '/opt/pis',
  runNpm = (args, options) => execFileSync('npm', args, options).toString('utf8'),
} = {}) {
  const { packages } = JSON.parse(fs.readFileSync(path.join(root, 'update-lock.json'), 'utf8'));
  if (
    !Array.isArray(packages) ||
    packages.length < 1 ||
    packages.length > 100 ||
    packages[0].name !== '@earendil-works/pi-coding-agent'
  )
    throw new Error('Invalid release lock.');
  const temp = fs.mkdtempSync('/tmp/pis-release-');
  const env = {
    ...process.env,
    npm_config_ignore_scripts: 'true',
    npm_config_userconfig: '/dev/null',
    npm_config_registry: 'https://registry.npmjs.org',
    npm_config_cache: path.join(temp, 'npm-cache'),
  };
  const npm = (args) =>
    runNpm(args, { cwd: temp, env, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const files = packages.map((pkg, index) => {
      if (
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name) ||
        !/^\d+\.\d+\.\d+$/.test(pkg.version)
      )
        throw new Error('Invalid release package.');
      const packed = JSON.parse(
        npm([
          'pack',
          '--ignore-scripts',
          '--json',
          '--registry=https://registry.npmjs.org',
          `${pkg.name}@${pkg.version}`,
        ]),
      )[0];
      if (
        !packed ||
        packed.name !== pkg.name ||
        packed.version !== pkg.version ||
        !/^[A-Za-z0-9._-]+\.tgz$/.test(packed.filename)
      )
        throw new Error('Unexpected packed release.');
      const file = path.join(temp, packed.filename);
      verifyPackedArtifact(file, pkg.integrity);
      // Scoped/unscoped npm names can pack to the same filename. Seal each
      // verified tarball before another pack can overwrite that pathname.
      const sealed = path.join(temp, `artifact-${index}.tgz`);
      fs.renameSync(file, sealed);
      return sealed;
    });
    npm(['install', '-g', '--ignore-scripts', '--no-audit', '--no-fund', files[0]]);
    if (files.length > 1) {
      const prefix = path.join(root, 'agent/npm');
      fs.mkdirSync(prefix, { recursive: true });
      fs.writeFileSync(
        path.join(prefix, 'package.json'),
        '{"name":"pis-image-extensions","private":true}\n',
      );
      npm([
        'install',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--omit=dev',
        '--legacy-peer-deps',
        '--no-audit',
        '--no-fund',
        ...files.slice(1),
      ]);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    installRelease();
  } catch {
    console.error('pis: verified release installation failed; candidate must not be activated.');
    process.exitCode = 1;
  }
}
