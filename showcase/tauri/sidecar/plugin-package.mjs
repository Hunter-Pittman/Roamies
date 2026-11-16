// Contained, immutable-by-policy package snapshots. Mutable server state belongs in PLUGIN_DATA.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { inspectPlugin, PLUGIN_LIMITS } from './plugin-format.mjs';
import { checkRead, resolvePluginPath, insidePluginRoot } from './safety.mjs';

/** Enumerates real-contained regular files, materializing in-root links and isolating inaccessible paths. */
async function walkPackage(root, visit) {
  const diagnostics = [];
  let files = 0, bytes = 0, entries = 0;
  async function walk(relative, ancestry, depth) {
    if (++entries > PLUGIN_LIMITS.files) throw new Error('Plugin exceeds the client package entry limit.');
    if (depth > PLUGIN_LIMITS.depth) { diagnostics.push({ component: 'package', entry: relative, message: 'Package directory depth limit reached; path skipped.' }); return; }
    let file, stat;
    try {
      file = await resolvePluginPath(root, relative);
      const read = checkRead(file, os.homedir()); if (read.level === 'block') throw new Error(read.reason);
      stat = await fs.stat(file);
    } catch (e) { diagnostics.push({ component: 'package', entry: relative, message: e.message }); return; }
    if (stat.isDirectory()) {
      if (ancestry.has(file)) { diagnostics.push({ component: 'package', entry: relative, message: 'Directory-link cycle skipped.' }); return; }
      await visit(relative, file, stat);
      const next = new Set(ancestry); next.add(file);
      let names;
      try { names = (await fs.readdir(file)).sort(); } catch (e) { diagnostics.push({ component: 'package', entry: relative, message: e.message }); return; }
      for (const name of names) await walk(path.join(relative, name), next, depth + 1);
    } else if (stat.isFile()) {
      files++; bytes += stat.size;
      if (files > PLUGIN_LIMITS.files || bytes > PLUGIN_LIMITS.bytes) throw new Error('Plugin exceeds client package file/byte resource limits.');
      await visit(relative, file, stat);
    } else diagnostics.push({ component: 'package', entry: relative, message: 'Non-regular package entry skipped.' });
  }
  await walk('.', new Set(), 0);
  return { diagnostics, files, bytes };
}

export async function packageDigest(root) {
  const hash = createHash('sha256');
  const scan = await walkPackage(root, async (relative, file, stat) => {
    if (stat.isDirectory()) { hash.update(JSON.stringify(['directory', relative.split(path.sep).join('/')])); return; }
    hash.update(JSON.stringify([relative.split(path.sep).join('/'), stat.mode & 0o111, stat.size]));
    hash.update(await fs.readFile(file)); hash.update('\0');
  });
  if (scan.diagnostics.length) throw new Error(`Installed package integrity cannot be established: ${scan.diagnostics[0].entry}.`);
  return { digest: hash.digest('hex'), files: scan.files, bytes: scan.bytes };
}

/** Destination is a fresh child of an existing client-owned root, never an arbitrary model-provided write path. */
export async function snapshotPlugin(source, ownedRoot, relative) {
  const original = await inspectPlugin(source);
  if (!original.valid) throw new Error(`Invalid plugin manifest: ${original.diagnostics[0]?.message}`);
  const destination = await resolvePluginPath(ownedRoot, relative, { missing: true });
  if (destination === await fs.realpath(ownedRoot)) throw new Error('A package snapshot needs its own directory.');
  if (insidePluginRoot(original.root, destination)) throw new Error('Cannot snapshot a plugin into its own source tree.');
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    const scan = await walkPackage(original.root, async (rel, file, stat) => {
      if (rel === '.') return;
      const out = await resolvePluginPath(destination, rel, { missing: true });
      if (!insidePluginRoot(destination, out)) throw new Error('Snapshot escaped its destination.');
      if (stat.isDirectory()) { await fs.mkdir(out, { recursive: false, mode: 0o700 }); return; }
      await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
      const content = await fs.readFile(file);
      await fs.writeFile(out, content, { flag: 'wx', mode: stat.mode & 0o777 });
      if (process.platform !== 'win32') await fs.chmod(out, stat.mode & 0o777);
    });
    const loaded = await inspectPlugin(destination);
    if (!loaded.valid) throw new Error('Plugin changed during snapshot creation; manifest no longer valid.');
    const identity = await packageDigest(destination);
    return { root: destination, ...identity, loaded,
      diagnostics: [...original.diagnostics, ...scan.diagnostics, ...loaded.diagnostics].filter((d, i, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(d)) === i) };
  } catch (e) {
    // The destination was created above and must still resolve to that exact owned directory before cleanup.
    const check = await resolvePluginPath(ownedRoot, relative);
    if (check === destination && !(await fs.lstat(destination)).isSymbolicLink()) await fs.rm(destination, { recursive: true, force: true });
    throw e;
  }
}
