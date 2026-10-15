import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/carrycheck.js', import.meta.url));
function run(args, cwd) { return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 20000 }); }
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'carrycheck-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function manifest(root, entries, filename = 'input.json') {
  const filenameAbsolute = path.join(root, filename);
  await writeFile(filenameAbsolute, JSON.stringify({ entries }));
  return filenameAbsolute;
}

test('help and version work from an unrelated working directory', async (t) => {
  const root = await fixture(t);
  const help = run(['--help'], root);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: carrycheck/);
  assert.match(help.stdout, /Exit codes/);
  assert.equal(help.stderr, '');
  const version = run(['--version'], root);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('JSON reports collision findings with exit 1 and no source directory leaks', async (t) => {
  const root = await fixture(t);
  const file = await manifest(root, [{ path: 'Readme.md', source: 'draft' }, { path: 'README.md', source: 'release' }]);
  const result = run(['--manifest', file, '--format', 'json'], root);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.target, 'windows');
  assert.ok(report.findings.some((finding) => finding.code === 'CASE_COLLISION'));
  assert.ok(!result.stdout.includes(root));
});

test('strict turns warning-only reports into exit 1', async (t) => {
  const root = await fixture(t);
  const file = await manifest(root, [{ path: 'zero\u200bwidth.txt' }]);
  const normal = run(['--manifest', file, '--format', 'json'], root);
  assert.equal(normal.status, 0, normal.stderr);
  const report = JSON.parse(normal.stdout);
  assert.equal(report.summary.errors, 0);
  assert.ok(report.summary.warnings > 0);
  const strict = run(['--manifest', file, '--format', 'json', '--strict'], root);
  assert.equal(strict.status, 1, strict.stderr);
});

test('multiple directories overlay their contents with unique anonymous labels', async (t) => {
  const root = await fixture(t);
  for (const name of ['left', 'right']) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'same.txt'), name);
  }
  const result = run(['left', 'right', '--format', 'json'], root);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  const sourceLabels = report.findings.flatMap((finding) => finding.paths.map((item) => item.source));
  assert.ok(sourceLabels.includes('source-1'));
  assert.ok(sourceLabels.includes('source-2'));
  assert.ok(!result.stdout.includes(root));
  assert.deepEqual((await readdir(root)).sort(), ['left', 'right']);
});

test('plans resolve from against the plan file and respect virtual mount points', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'plans'));
  await mkdir(path.join(root, 'source'));
  await writeFile(path.join(root, 'source', 'item.txt'), '');
  const file = path.join(root, 'plans', 'handoff.json');
  await writeFile(file, JSON.stringify({ sources: [
    { from: '../source', to: 'package', label: 'working' },
    { from: '../source', to: 'package', label: 'backup' }
  ] }));
  const result = run(['--plan', file, '--format', 'json'], tmpdir());
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.findings.some((finding) => finding.paths.some((item) => item.path === 'package/item.txt' && item.source === 'working')));
  assert.ok(report.findings.some((finding) => finding.paths.some((item) => item.source === 'backup')));
  assert.ok(!result.stdout.includes(root));
});

test('default scan omits metadata/dependency trees and honors -- and exclusions', async (t) => {
  const root = await fixture(t);
  for (const name of ['.git', 'node_modules', '-input']) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'one'), '');
  }
  const clean = run(['--format', 'json'], root);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout).summary.entries, 2);
  const all = run(['--format', 'json', '--include-defaults'], root);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(JSON.parse(all.stdout).summary.entries, 6);
  const excluded = run(['--format', 'json', '--exclude', 'one', '--', '-input'], root);
  assert.equal(excluded.status, 0, excluded.stderr);
  assert.equal(JSON.parse(excluded.stdout).summary.entries, 0);
});

test('rejects invalid CLI arguments and malformed input before writing a report', async (t) => {
  const root = await fixture(t);
  const good = await manifest(root, []);
  const bad = path.join(root, 'bad.json');
  await writeFile(bad, '{ nope');
  const invalid = [
    ['--unknown'], ['--target'], ['--target', 'linux'], ['--format', 'xml'],
    ['--root-length', '-1'], ['--root-length', '1.5'], ['--max-path', '0'],
    ['--max-path', '9007199254740992'], ['--target', 'windows', '--target', 'macos'],
    ['--plan', good, '--manifest', good], ['--manifest', good, '.'],
    ['--manifest', good, '--exclude', 'x'], ['--exclude', '../x'],
    ['--manifest', bad], ['does-not-exist']
  ];
  for (const args of invalid) {
    const result = run(args, root);
    assert.equal(result.status, 2, JSON.stringify(args) + result.stderr);
    assert.equal(result.stdout, '', JSON.stringify(args));
    assert.match(result.stderr, /^carrycheck: .+\n$/);
  }
});

test('rejects malformed manifest entries and plans with controlled exit 2', async (t) => {
  const root = await fixture(t);
  const input = path.join(root, 'input.json');
  const manifests = [null, {}, { entries: 'bad' }, { entries: [null] }, { entries: [{ path: 3 }] }, { entries: [{ path: '../escape' }] }];
  for (const value of manifests) {
    await writeFile(input, JSON.stringify(value));
    const result = run(['--manifest', input, '--format', 'json'], root);
    assert.equal(result.status, 2, JSON.stringify(value) + result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('TypeError:'));
  }
  const plans = [null, {}, { sources: [] }, { sources: [null] }, { sources: [{ from: 3 }] }, { sources: [{ from: '.', to: '../escape' }] }, { sources: [{ from: '.', label: '' }] }, { sources: [{ from: '.', label: 'same' }, { from: '.', label: 'same' }] }];
  for (const value of plans) {
    await writeFile(input, JSON.stringify(value));
    const result = run(['--plan', input, '--format', 'json'], root);
    assert.equal(result.status, 2, JSON.stringify(value) + result.stderr);
    assert.equal(result.stdout, '');
  }
});

test('accepts array manifests and validates explicit path budget options', async (t) => {
  const root = await fixture(t);
  const input = path.join(root, 'array.json');
  await writeFile(input, JSON.stringify([{ path: 'plain.txt' }]));
  const result = run(['--manifest', input, '--format', 'json', '--target', 'posix', '--root-length', '0', '--max-path', '4096'], root);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.target, 'posix');
  assert.equal(report.summary.entries, 1);
});
