import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJson, formatText, formatMarkdown } from '../src/report.js';

function sample() {
  return {
    schemaVersion: 1,
    target: 'windows',
    summary: { entries: 2, errors: 1, warnings: 0 },
    budget: { maxPath: 259, rootLength: 40, unit: 'utf16', longestRelativePath: 19, remainingRootBudget: 239 },
    findings: [{
      code: 'OVERWRITE', severity: 'error', message: 'Multiple source entries occupy the same destination name.',
      paths: [{ path: 'shared.txt', source: 'draft' }, { path: 'shared.txt', source: 'release' }],
      hint: 'Choose separate mount points.'
    }]
  };
}

test('all serializers include actionable source mappings and path budgets', () => {
  const report = sample();
  for (const render of [formatText, formatMarkdown]) {
    const output = render(report);
    for (const expected of ['windows', 'OVERWRITE', 'draft', 'release', '259', '40', '19', '239', 'UTF-16']) assert.ok(output.includes(expected), expected);
    assert.match(output, /Choose separate mount points/);
    assert.ok(output.endsWith('\n'));
  }
  const text = formatText(report);
  assert.ok(text.includes('Source "draft": "shared.txt"'));
  assert.ok(text.includes('Source "release": "shared.txt"'));
  assert.ok(text.includes('ERROR OVERWRITE'));
  assert.ok(formatMarkdown(report).includes('ERROR — OVERWRITE'));
});

test('JSON preserves adversarial characters and formatting is deterministic', () => {
  const report = sample();
  report.findings[0].paths[0] = { path: 'line\n![image](https://example.test/x)\u001b\u0085\u202e', source: 'untrusted\\source' };
  const output = formatJson(report);
  assert.deepEqual(JSON.parse(output), report);
  assert.ok(output.includes('\n  "schemaVersion": 1,'));
  assert.ok(output.endsWith('\n'));
  assert.equal(output, formatJson(report));
});

test('terminal output distinguishes newline, literal backslash-n, and quotes without controls', () => {
  const report = sample();
  report.findings[0].paths = [
    { path: 'a\nb', source: 'new\nline' },
    { path: 'a\\nb', source: 'literal' },
    { path: '"quoted"\u001b[2J\u0085\u202e\u2066', source: '\u009bsource\u2069' }
  ];
  const output = formatText(report);
  assert.ok(output.includes('"a\\nb"'));
  assert.ok(output.includes('"a\\\\nb"'));
  assert.ok(output.includes('\\"quoted\\"'));
  assert.ok(output.includes('\\u001b'));
  assert.ok(output.includes('\\u0085'));
  assert.ok(output.includes('\\u202e'));
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(output));
});

test('Markdown encodes images, links, HTML and every backslash in all untrusted fields', () => {
  const report = sample();
  const payload = '![pixel](https://example.test/beacon) [link](https://example.test) <img src=x> \\*`|&#33;\n\u001b\u202e';
  report.target = payload;
  Object.assign(report.findings[0], { code: payload, severity: payload, message: payload, hint: payload });
  report.findings[0].paths = [{ path: payload, source: payload }];
  const output = formatMarkdown(report);
  for (const raw of ['![', '](', '<img', '`', '\\', '\u001b', '\u202e', 'https://']) assert.ok(!output.includes(raw), JSON.stringify(raw));
  for (const encoded of ['&#33;&#91;pixel&#93;&#40;https&#58;&#47;&#47;', '&lt;img src&#61;x&gt;', '&#92;', '&#96;', '&#124;', '&amp;']) assert.ok(output.includes(encoded), encoded);
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(output));
});

test('serializers do not mutate deeply frozen reports and success appears once', () => {
  const report = sample();
  const freeze = (value) => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  const before = JSON.stringify(report);
  freeze(report);
  for (const render of [formatText, formatMarkdown, formatJson]) render(report);
  assert.equal(JSON.stringify(report), before);
  const clean = { ...report, findings: [], budget: null, summary: { entries: 0, errors: 0, warnings: 0 } };
  for (const render of [formatText, formatMarkdown]) {
    const output = render(clean);
    assert.equal(output.match(/No findings\./g)?.length, 1);
    assert.match(output, /Path budget: unavailable/);
  }
});
