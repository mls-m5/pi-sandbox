import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOTS = ['bin', 'src', 'web', 'gnome-codex-usage', 'scripts', 'test'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'coverage', 'dist']);

export function discoverSyntaxChecks(root) {
  const javascript = [],
    shell = [];
  function visit(relative) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file).sort()) {
        if (!entry.startsWith('.') && !SKIP_DIRECTORIES.has(entry))
          visit(path.join(relative, entry));
      }
    } else if (stat.isFile()) {
      if (/\.(?:js|mjs|cjs)$/.test(relative)) javascript.push(relative);
      else if (relative.endsWith('.sh') || relative === path.join('src', 'runtime', 'pi-launcher'))
        shell.push(relative);
    }
  }
  for (const directory of SOURCE_ROOTS) visit(directory);
  for (const entry of fs.readdirSync(root).sort()) if (entry.endsWith('.sh')) visit(entry);
  return { javascript: javascript.sort(), shell: shell.sort() };
}

export function checkSyntax(root) {
  const files = discoverSyntaxChecks(root);
  for (const file of files.javascript) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], {
      stdio: 'inherit',
    });
    if (result.error || result.status !== 0)
      throw new Error(`JavaScript syntax check failed: ${file}`);
  }
  for (const file of files.shell) {
    const result = spawnSync('bash', ['-n', '--', path.join(root, file)], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Shell syntax check failed: ${file}`);
  }
  console.log(
    `Syntax OK: ${files.javascript.length} JavaScript modules, ${files.shell.length} shell scripts.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    checkSyntax(fileURLToPath(new URL('..', import.meta.url)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
