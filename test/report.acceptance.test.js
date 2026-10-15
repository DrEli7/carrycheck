import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJson, formatText, formatMarkdown } from '../src/report.js';

const report = {
  schemaVersion: 1, target: 'windows',
  summary: { entries: 3, errors: 1, warnings: 1 },
  budget: { maxPath: 259, rootLength: 40, longestRelativePath: 24, remainingRootBudget: 234 },
  findings: [
    { code: 'CASE_COLLISION', severity: 'error', message: 'Names collide.', paths: [{ path: 'A.txt', source: 'left' }, { path: 'a.txt', source: 'right' }], hint: 'Rename before merging.' },
    { code: 'INVISIBLE_NAME', severity: 'warning', message: 'Invisible name.', paths: [{ path: 'x|<script>\u001b[31m\n\u202efile`', source: 'draft' }], hint: 'Inspect the name.' }
  ]
};

test('JSON is lossless, newline terminated and deterministic', () => {
  assert.deepEqual(JSON.parse(formatJson(report)), report);
  assert.ok(formatJson(report).endsWith('\n'));
  assert.equal(formatJson(report), formatJson(report));
});
test('text explains both source mappings and findings without terminal controls', () => {
  const output = formatText(report);
  for (const value of ['windows', '3', 'CASE_COLLISION', 'A.txt', 'a.txt', 'left', 'right', 'Rename before merging.']) assert.ok(output.includes(value), value);
  assert.ok(!output.includes('\u001b'));
  assert.ok(!output.includes('\u202e'));
  assert.ok(output.includes('\\n'));
});
test('Markdown is shareable without embedding path HTML or breaking rows', () => {
  const output = formatMarkdown(report);
  assert.match(output, /CarryCheck/i);
  assert.ok(output.includes('CASE_COLLISION'));
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('\u001b'));
  assert.ok(!output.includes('\u202e'));
  assert.ok(output.includes('left'));
  assert.ok(output.includes('remaining') || output.includes('Remaining'));
});
test('empty reports render useful success output and do not mutate input', () => {
  const clean = { ...report, summary: { entries: 0, errors: 0, warnings: 0 }, budget: null, findings: [] };
  const before = JSON.stringify(clean);
  for (const render of [formatText, formatMarkdown, formatJson]) assert.ok(render(clean).length > 0);
  assert.equal(JSON.stringify(clean), before);
});
