// Keep untrusted filenames and labels visible without terminal or Markdown effects.
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
const escapedControl = (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
const visible = (value) => String(value).replace(CONTROLS, escapedControl);
const quoted = (value) => JSON.stringify(String(value)).replace(CONTROLS, escapedControl);

function markdown(value) {
  // Character references display punctuation literally. They cannot introduce
  // Markdown links/images, HTML, emphasis, code, tables or backslash escapes.
  return visible(value).replace(/[!-/:-@[-`{-~]/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '"') return '&quot;';
    if (character === "'") return '&#39;';
    return `&#${character.charCodeAt(0)};`;
  });
}

function markdownCode(code) {
  // Audit codes use uppercase identifiers; retain their searchable spelling.
  return /^[A-Z][A-Z0-9_]*$/.test(code) ? code : markdown(code);
}

function unitName(budget, target) {
  return budget.unit === 'utf16' || (!budget.unit && target === 'windows') ? 'UTF-16 code units' : 'UTF-8 bytes';
}

/** Lossless machine-readable output. JSON itself escapes C0 string controls. */
export function formatJson(report) {
  return JSON.stringify(report, null, 2) + '\n';
}

/** Readable terminal output with quoted, unambiguous path and source spellings. */
export function formatText(report) {
  const { summary, budget } = report;
  const lines = [
    `CarryCheck — ${visible(report.target)}`,
    `Entries: ${visible(summary.entries)} | Errors: ${visible(summary.errors)} | Warnings: ${visible(summary.warnings)}`
  ];
  if (budget) {
    lines.push(
      `Path budget (${unitName(budget, report.target)}):`,
      `  Root length: ${visible(budget.rootLength)}; maximum path: ${visible(budget.maxPath)}`,
      `  Longest relative path: ${visible(budget.longestRelativePath)}; remaining root budget: ${visible(budget.remainingRootBudget)}`
    );
  } else lines.push('Path budget: unavailable.');
  lines.push('');
  if (!report.findings.length) lines.push('No findings.');
  for (const finding of report.findings) {
    lines.push(`${visible(finding.severity).toUpperCase()} ${visible(finding.code)}: ${visible(finding.message)}`);
    for (const entry of finding.paths) lines.push(`  Source ${quoted(entry.source)}: ${quoted(entry.path)}`);
    lines.push(`  Hint: ${visible(finding.hint)}`, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** Shareable CommonMark with every untrusted punctuation character rendered literally. */
export function formatMarkdown(report) {
  const { summary, budget } = report;
  const lines = [
    '# CarryCheck', '',
    `Target: ${markdown(report.target)}`, '',
    `Entries: ${markdown(summary.entries)} · Errors: ${markdown(summary.errors)} · Warnings: ${markdown(summary.warnings)}`, '',
    '## Path budget', ''
  ];
  if (budget) {
    lines.push(
      `Measured in ${unitName(budget, report.target)}.`, '',
      `- Root length: ${markdown(budget.rootLength)}`,
      `- Maximum path: ${markdown(budget.maxPath)}`,
      `- Longest relative path: ${markdown(budget.longestRelativePath)}`,
      `- Remaining root budget: ${markdown(budget.remainingRootBudget)}`, ''
    );
  } else lines.push('Path budget: unavailable.', '');
  if (!report.findings.length) lines.push('No findings.');
  else {
    lines.push('## Findings', '');
    report.findings.forEach((finding, index) => {
      lines.push(`### ${index + 1}. ${markdown(finding.severity.toUpperCase())} — ${markdownCode(finding.code)}`, '', markdown(finding.message), '');
      for (const entry of finding.paths) lines.push(`- Source ${markdown(quoted(entry.source))}: ${markdown(quoted(entry.path))}`);
      lines.push('', `Hint: ${markdown(finding.hint)}`, '');
    });
  }
  return lines.join('\n').trimEnd() + '\n';
}
