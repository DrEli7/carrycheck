import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { scanDirectory } from '../src/scan.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'carrycheck-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('scans metadata deterministically and mounts an empty or populated tree', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'notes'));
  await writeFile(path.join(root, 'z.txt'), 'No contents should appear in the audit.');
  await writeFile(path.join(root, 'notes', 'a.txt'), 'private contents');
  const entries = await scanDirectory(root, { source: 'draft', to: 'bundle/docs' });
  assert.deepEqual(entries, [
    { path: 'bundle/docs', source: 'draft', type: 'directory' },
    { path: 'bundle/docs/notes', source: 'draft', type: 'directory' },
    { path: 'bundle/docs/notes/a.txt', source: 'draft', type: 'file' },
    { path: 'bundle/docs/z.txt', source: 'draft', type: 'file' }
  ]);
  assert.ok(!JSON.stringify(entries).includes(root));
  const empty = await fixture(t);
  assert.deepEqual(await scanDirectory(empty), []);
  assert.deepEqual(await scanDirectory(empty, { to: 'empty' }), [{ path: 'empty', source: 'source', type: 'directory' }]);
});

test('exclusions match exact relative subtrees or a basename at any depth', async (t) => {
  const root = await fixture(t);
  for (const directory of ['a', 'a/cache', 'a/keep', 'b', 'b/cache']) await mkdir(path.join(root, directory), { recursive: true });
  for (const file of ['a/cache/x', 'a/keep/x', 'b/cache/x', 'b/kept']) await writeFile(path.join(root, file), '');
  const paths = (await scanDirectory(root, { exclude: ['cache', 'a/keep'] })).map((entry) => entry.path);
  assert.deepEqual(paths, ['a', 'b', 'b/kept']);
  const exact = (await scanDirectory(root, { exclude: ['a/cache'] })).map((entry) => entry.path);
  assert.ok(exact.includes('b/cache/x'));
  assert.ok(!exact.includes('a/cache'));
});

test('preserves an initial Unicode BOM in a filename', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, '\uFEFFnotes.txt'), '');
  assert.deepEqual(await scanDirectory(root), [{ path: '\uFEFFnotes.txt', source: 'source', type: 'file' }]);
});

test('fails closed on missing roots, files, unsafe options and entry limits', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'one');
  await writeFile(file, '');
  await assert.rejects(scanDirectory(path.join(root, 'missing')), /Cannot inspect.*ENOENT/);
  await assert.rejects(scanDirectory(file), /must be a directory/);
  for (const to of ['/absolute', '../up', 'a/../b', 'a//b', 'a\\b', 'C:/drive', '.', 'a/']) {
    await assert.rejects(scanDirectory(root, { to }), /relative path/);
  }
  await assert.rejects(scanDirectory(root, { source: '' }), /Source label/);
  await assert.rejects(scanDirectory(root, { exclude: [null] }), /Exclusion/);
  await assert.rejects(scanDirectory(root, { exclude: 'one' }), /Exclusions/);
  await assert.rejects(scanDirectory(root, { maxEntries: 0 }), /positive safe integer/);
  await writeFile(path.join(root, 'two'), '');
  await assert.rejects(scanDirectory(root, { maxEntries: 1 }), /entry limit/);
});

test('records symlinks without scanning targets and rejects a symlink root', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(path.join(outside, 'hidden.txt'), '');
  const link = path.join(root, 'external');
  try { await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`Symlink creation is unavailable: ${error.code}`);
    throw error;
  }
  const entries = await scanDirectory(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'external');
  assert.equal(entries[0].type, 'symlink');
  assert.equal(typeof entries[0].linkTarget, 'string');
  await assert.rejects(scanDirectory(link), /root.*is a symlink/);
});

test('rejects invalid UTF-8 filesystem names instead of replacing their bytes', { skip: process.platform === 'win32' ? 'Windows filenames use UTF-16, not arbitrary byte names.' : false }, async (t) => {
  const root = await fixture(t);
  try {
    await writeFile(Buffer.concat([Buffer.from(root + path.sep), Buffer.from([0xff])]), '');
  } catch (error) {
    // APFS can reject invalid bytes before a directory entry can exist.
    if (error.code === 'EILSEQ') return t.skip('This filesystem rejects invalid UTF-8 filenames at creation.');
    throw error;
  }
  await assert.rejects(scanDirectory(root), /not valid UTF-8/);
});

test('rejects unsupported socket entries', { skip: process.platform === 'win32' ? 'Windows named pipes are outside ordinary directory trees.' : false }, async (t) => {
  const root = await fixture(t);
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.join(root, 'socket'), resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(scanDirectory(root), /Unsupported filesystem entry/);
});
