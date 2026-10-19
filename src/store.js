import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PROJECT_SCHEMA } from './config-schema.js';
import { completeConfig, defaults, validate, ID_PATTERN } from './config.js';
import { assert, directory, privateDir, readJson, writeJson, withLock, within } from './util.js';

export class Store {
  constructor(root = process.env.PIS_HOME || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'pis')) {
    assert(path.isAbsolute(root), 'PIS_HOME/XDG_DATA_HOME must be absolute.');
    privateDir(root);
    this.root = fs.realpathSync(root);
    this.projectsDir = path.join(this.root, 'projects');
    privateDir(this.projectsDir);
  }
  projectDir(id) {
    assert(ID_PATTERN.test(id), 'Invalid project ID.');
    return path.join(this.projectsDir, id);
  }
  configPath(id) { return path.join(this.projectDir(id), 'project.json'); }
  lock(action) { return withLock(path.join(this.root, 'registry.lock'), action); }
  projectLock(id, action) { return withLock(path.join(this.projectDir(id), 'project.lock'), action); }

  all() {
    const projects = [];
    for (const entry of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      const file = this.configPath(entry.name);
      if (!fs.existsSync(file)) continue; // Ignore an interrupted registration before its atomic write.
      const config = validate(completeConfig(readJson(file)), { storage: this.root, paths: false });
      assert(config.id === entry.name, `Project ID does not match storage directory: ${file}`);
      projects.push(config);
    }
    this.unique(projects);
    return projects.sort((a, b) => a.root.localeCompare(b.root));
  }
  unique(projects) {
    const names = new Set(), roots = new Set(), ids = new Set(projects.map(p => p.id));
    for (const p of projects) {
      assert(!roots.has(p.root), `Duplicate registered root: ${p.root}`);
      roots.add(p.root);
      if (p.name) {
        assert(!names.has(p.name) && !ids.has(p.name), `Project name conflicts with another name or ID: ${p.name}`);
        names.add(p.name);
      }
    }
  }
  index(projects = this.all()) {
    writeJson(path.join(this.root, 'index.json'), { version: 1, projects: projects.map(({ id, name, root }) => ({ id, ...(name ? { name } : {}), root })) });
  }
  select(cwd, selector) {
    const all = this.all(); // Source configs are authoritative; the cache can always be rebuilt.
    let project;
    if (selector) {
      project = all.find(p => p.id === selector || p.name === selector);
      assert(project, `Unknown project: ${selector}. Use pis --list.`);
    } else {
      const canonical = directory(cwd);
      project = all.filter(p => within(p.root, canonical)).sort((a, b) => b.root.length - a.root.length)[0];
      assert(project, 'No pis project found for this directory. Run pis --new to create one here.');
    }
    return project;
  }
  load(id, paths = true) {
    return validate(completeConfig(readJson(this.configPath(id))), { storage: this.root, paths });
  }
  write(config) {
    const schema = path.join(this.projectDir(config.id), 'project.schema.json');
    const schemaText = `${JSON.stringify(PROJECT_SCHEMA, null, 2)}\n`;
    if (!fs.existsSync(schema) || fs.readFileSync(schema, 'utf8') !== schemaText) writeJson(schema, PROJECT_SCHEMA);
    writeJson(this.configPath(config.id), config);
  }
  async refresh(id) {
    return this.lock(async () => {
      const config = this.load(id, false);
      const text = `${JSON.stringify(config, null, 2)}\n`;
      const schema = path.join(this.projectDir(id), 'project.schema.json');
      if (fs.readFileSync(this.configPath(id), 'utf8') !== text || !fs.existsSync(schema) || fs.readFileSync(schema, 'utf8') !== `${JSON.stringify(PROJECT_SCHEMA, null, 2)}\n`) this.write(config);
      return config;
    });
  }
  async register(cwd, name) {
    return this.lock(async () => {
      const root = directory(cwd), all = this.all();
      assert(!all.some(p => p.root === root), `A project is already registered at ${root}.`);
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let id;
      do { id = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
      while (all.some(p => p.id === id || p.name === id) || fs.existsSync(this.projectDir(id)));
      const config = validate(defaults(id, root, name), { storage: this.root });
      this.unique([...all, config]);
      privateDir(this.projectDir(id));
      privateDir(path.join(this.projectDir(id), 'state'));
      this.write(config);
      this.index([...all, config]);
      return config;
    });
  }
  async save(config, original) {
    return this.lock(async () => {
      const current = this.load(original.id, false);
      assert(isDeepStrictEqual(current, original), 'Configuration changed while editing. Your draft is retained; reopen and merge your changes.');
      config = completeConfig(config);
      validate(config, { storage: this.root, identity: original });
      const all = this.all().map(p => p.id === config.id ? config : p);
      this.unique(all);
      this.write(config);
      this.index(all);
    });
  }
  async relocate(selector, cwd) {
    const selected = this.select(cwd, selector);
    return this.projectLock(selected.id, () => this.lock(async () => {
      const all = this.all(), current = all.find(p => p.id === selected.id);
      assert(current, 'Project no longer exists.');
      const config = { ...current, root: directory(cwd) };
      validate(config, { storage: this.root });
      const updated = all.map(p => p.id === config.id ? config : p);
      this.unique(updated);
      this.write(config);
      this.index(updated);
      return config;
    }));
  }
}
