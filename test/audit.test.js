import test from 'node:test';
import assert from 'node:assert/strict';
import { audit } from '../src/audit.js';

const codes = (entries, options) => audit(entries, options).findings.map((item) => item.code);
const file = (path, source = 'one') => ({ path, source });
const dir = (path) => ({ path, type: 'directory' });
const link = (path, linkTarget) => ({ path, type: 'symlink', linkTarget });
const errors = (entries, options = { target: 'posix' }) => audit(entries, options).findings.filter((item) => item.severity === 'error');

test('clean trees include truthful summary and deterministic path budget', () => {
  const report = audit([file('docs/hello.txt')]);
  assert.deepEqual(report.summary, { entries: 1, errors: 0, warnings: 0 });
  assert.deepEqual(report.budget, { maxPath: 259, rootLength: 40, unit: 'utf16', longestRelativePath: 14, remainingRootBudget: 244 });
  assert.equal(audit([]).budget.remainingRootBudget, 259);
});

test('exact file overlays report both sources, but ordinary directory merges are valid', () => {
  const entries = [file('data/readme', 'left'), file('data/readme', 'right')];
  const overwrite = audit(entries).findings.find((item) => item.code === 'OVERWRITE');
  assert.deepEqual(overwrite.paths, [{ path: 'data/readme', source: 'left' }, { path: 'data/readme', source: 'right' }]);
  assert.deepEqual(codes([{ ...dir('data'), source: 'left' }, { ...dir('data'), source: 'right' }, file('data/a', 'left'), file('data/b', 'right')]), []);
});

test('virtual mount points separate otherwise colliding sources', () => {
  assert.deepEqual(codes([file('left/Readme.txt'), file('right/README.txt')]), []);
});

test('case aliases include inferred parents and child overwrites after directory merges', () => {
  const report = audit([file('Data/same.txt', 'left'), file('data/same.txt', 'right')]);
  assert.ok(report.findings.some((item) => item.code === 'CASE_COLLISION' && item.paths[0].path === 'Data'));
  assert.ok(report.findings.some((item) => item.code === 'OVERWRITE' && item.paths[0].path === 'Data/same.txt'));
});

test('NFC collisions and noncanonical spellings are explained separately', () => {
  const result = codes([file('café.txt'), file('cafe\u0301.txt')]);
  assert.ok(result.includes('UNICODE_COLLISION'));
  assert.ok(result.includes('NON_NFC_NAME'));
});

test('posix profile preserves exact spellings while macos uses NFC and lowercase', () => {
  const entries = [file('File'), file('file'), file('é'), file('e\u0301')];
  assert.deepEqual(codes(entries, { target: 'posix' }), []);
  const result = codes(entries, { target: 'macos' });
  assert.ok(result.includes('CASE_COLLISION'));
  assert.ok(result.includes('UNICODE_COLLISION'));
  assert.ok(!result.includes('WINDOWS_RESERVED'));
});

for (const name of ['CON', 'nul.tar.gz', 'PRN.txt', 'COM¹.csv', 'LPT²', 'aux/data', 'CONIN$.txt']) {
  test(`Windows device name ${JSON.stringify(name)} is rejected, including ancestors`, () => {
    assert.ok(codes([file(name)]).includes('WINDOWS_RESERVED'));
  });
}
test('ordinary names that resemble devices are accepted', () => {
  assert.deepEqual(codes(['COM0', 'COM10', 'console.txt', 'auxiliary', 'LPT4data'].map((name) => file(name))), []);
});
test('Windows punctuation, trailing aliases and controls are visible', () => {
  const result = codes([file('report:a'), file('name.'), file('name'), file('a\n.txt')]);
  for (const code of ['WINDOWS_CHARACTER', 'WINDOWS_TRAILING', 'WINDOWS_ALIAS_COLLISION', 'INVISIBLE_NAME']) assert.ok(result.includes(code), code);
});
test('invisible and bidi characters remain warnings when otherwise legal', () => {
  const report = audit([file('zero\u200bwidth'), file('bidirectional\u202e')]);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.warnings, 2);
});
test('file-directory and symlink-directory conflicts include implied ancestors', () => {
  for (const entry of [file('assets'), link('assets', 'other')]) {
    assert.ok(codes([entry, file('assets/image.png')]).includes('TYPE_CONFLICT'));
  }
  assert.ok(codes([file('ASSETS'), file('assets/image.png')]).includes('TYPE_CONFLICT'));
});
test('configured path budget uses an explicit root and separator', () => {
  assert.ok(!codes([file('abc')], { rootLength: 5, maxPath: 9 }).includes('PATH_BUDGET'));
  const report = audit([file('abcd')], { rootLength: 5, maxPath: 9 });
  assert.ok(report.findings.some((item) => item.code === 'PATH_BUDGET'));
  assert.equal(report.budget.remainingRootBudget, 4);
});
test('Windows counts UTF16 units and posix counts UTF8 bytes', () => {
  const windows = audit([file('😀')], { rootLength: 0, maxPath: 4 });
  const posix = audit([file('😀')], { target: 'posix', rootLength: 0, maxPath: 4 });
  assert.equal(windows.budget.longestRelativePath, 2);
  assert.equal(windows.summary.errors, 0);
  assert.equal(posix.budget.longestRelativePath, 4);
  assert.ok(posix.findings.some((item) => item.code === 'PATH_BUDGET'));
});
test('component budget catches byte-heavy names independently of overall path budget', () => {
  assert.ok(codes([file('界'.repeat(86))], { target: 'posix', maxPath: 4095 }).includes('COMPONENT_BUDGET'));
  assert.ok(!codes([file('界'.repeat(86))], { target: 'windows', maxPath: 4095 }).includes('COMPONENT_BUDGET'));
});
test('valid relative file and directory symlinks generate only portability warnings', () => {
  assert.deepEqual(errors([file('data/ok'), link('latest', 'data'), link('one', 'latest/ok'), link('data/self', '../data/ok')]), []);
});
test('absolute POSIX, drive and UNC symlinks are not portable', () => {
  for (const target of ['/tmp/data', 'C:\\data', '\\\\server\\share']) assert.ok(codes([link('one', target)]).includes('SYMLINK_ABSOLUTE'));
});
test('missing targets, non-directory ancestors and excluded targets are detected', () => {
  for (const entries of [[link('one', 'missing')], [file('file'), link('one', 'file/child')], [file('file'), link('one', 'file/')]]) assert.ok(codes(entries).includes('SYMLINK_DANGLING'));
});
test('direct escapes and indirect escapes are detected', () => {
  assert.ok(codes([link('one', '../outside')]).includes('SYMLINK_ESCAPE'));
  assert.ok(codes([file('secret'), link('a', '.'), link('probe', 'a/../secret')]).includes('SYMLINK_ESCAPE'));
});
test('symlink expansion precedes parent traversal', () => {
  const entries = [dir('real/deep'), file('real/secret'), link('alias', 'real/deep'), link('probe', 'alias/../secret')];
  assert.deepEqual(errors(entries), []);
});
test('repeated use of a link is valid when resolution makes progress', () => {
  assert.deepEqual(errors([file('file'), link('a', '.'), link('probe', 'a/a/file')]), []);
});
test('self and mutual symlink cycles are bounded and explained', () => {
  assert.ok(codes([link('one', 'one')]).includes('SYMLINK_CYCLE'));
  assert.ok(codes([link('one', 'two'), link('two', 'one')]).includes('SYMLINK_CYCLE'));
  assert.ok(codes([link('one', 'one/child')]).includes('SYMLINK_DEPTH'));
});
test('a link crossing an overlaid destination is reported as ambiguous', () => {
  assert.ok(codes([file('data', 'left'), file('data', 'right'), link('one', 'data')]).includes('SYMLINK_AMBIGUOUS'));
});
test('symlinks to the virtual root are valid and backslash targets are explained', () => {
  assert.deepEqual(errors([link('one', '.')]), []);
  assert.ok(codes([link('one', 'data\\file')]).includes('SYMLINK_SEPARATOR'));
});
test('schema, path traversal and budget mistakes fail before a report is produced', () => {
  for (const entries of [null, {}, [null], [3], [{ path: 3 }], [file('')], [file('../x')], [file('a/../x')], [file('a//x')], [file('/x')], [file('C:x')], [file('a\0b')], [file('\ud800')], [{ path: 'x', type: 'socket' }], [link('x', '')], [{ path: 'x', source: 3 }]]) assert.throws(() => audit(entries));
  for (const options of [{ target: 'linux' }, { rootLength: -1 }, { maxPath: 0 }, { maxPath: 1.5 }]) assert.throws(() => audit([], options));
});
test('audit is deterministic across input ordering and does not mutate caller data', () => {
  const entries = [file('A', 'left'), file('a', 'right'), file('NUL'), link('l', '../x')];
  const before = JSON.stringify(entries);
  const first = audit(entries);
  assert.deepEqual(first, audit([...entries].reverse()));
  assert.equal(JSON.stringify(entries), before);
});

test('resource limits reject deep trees and oversized strings before materializing ancestors', () => {
  assert.doesNotThrow(() => audit([file(Array(256).fill('a').join('/'))], { maxPath: 4095 }));
  assert.throws(() => audit([file(Array(257).fill('a').join('/'))]), /analysis limit/);
  assert.doesNotThrow(() => audit([link('a', Array(256).fill('.').join('/'))]));
  assert.throws(() => audit([link('a', Array(257).fill('.').join('/'))]), /analysis limit/);
  assert.doesNotThrow(() => audit([file('a'.repeat(32768))]));
  assert.throws(() => audit([file('a'.repeat(32769))]), /analysis limit/);
  assert.doesNotThrow(() => audit([file('a', 's'.repeat(256))]));
  assert.throws(() => audit([file('a', 's'.repeat(257))]), /analysis limit/);
  assert.throws(() => audit(Array(100001).fill(file('a'))), /at most 100000/);
  assert.throws(() => audit(Array(501).fill(file('a'.repeat(32000)))), /textual analysis limit/);
});
