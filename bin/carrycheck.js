#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../src/audit.js';
import { formatJson, formatText, formatMarkdown } from '../src/report.js';
import { scanDirectory, validateRelativePath } from '../src/scan.js';

const HELP = `CarryCheck — inspect directory handoffs before files collide.

Usage: carrycheck [options] [directory ...]
       carrycheck --plan FILE [options]
       carrycheck --manifest FILE [options]

Directory contents overlay one virtual root. With no input, scan .

  --plan FILE          JSON sources: [{ from, to?, label? }], from relative to plan
  --manifest FILE      JSON entries array, or { entries: [...] }; no disk scan
  --target TARGET      windows (default), macos, or posix
  --format FORMAT      text (default), json, or markdown
  --root-length N      Destination root length (default: 40)
  --max-path N         Full destination path limit (default: 259)
  --exclude PATH       Exclude relative path/subtree or basename at any depth
  --include-defaults   Include normally excluded .git and node_modules directories
  --strict             Exit 1 for warnings as well as errors
  --help               Show this help
  --version            Show version
  --                   Treat remaining arguments as directory paths

Exit codes: 0 clean (warnings allowed), 1 findings, 2 input/scan failure.
`;

function argumentError(message) { throw new Error(message); }
function nonemptyString(value, name) {
  if (typeof value !== 'string' || !value.length || !value.isWellFormed() || value.includes('\0')) argumentError(`${name} must be a nonempty well-formed string without NUL.`);
  return value;
}
function integer(value, name, minimum) {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) argumentError(`${name} must be a ${minimum ? 'positive' : 'nonnegative'} safe integer.`);
  return Number(value);
}

function parseArgs(argv) {
  const options = { target: 'windows', format: 'text', rootLength: 40, maxPath: 259, exclude: [], includeDefaults: false, strict: false, directories: [] };
  const seen = new Set();
  let positional = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (positional) { options.directories.push(arg); continue; }
    if (arg === '--') { positional = true; continue; }
    if (!arg.startsWith('-') || arg === '-') { options.directories.push(arg); continue; }
    if (['--help', '--version', '--strict', '--include-defaults'].includes(arg)) {
      if (seen.has(arg)) argumentError(`Duplicate option: ${arg}`);
      seen.add(arg);
      options[{ '--help': 'help', '--version': 'version', '--strict': 'strict', '--include-defaults': 'includeDefaults' }[arg]] = true;
      continue;
    }
    const keys = { '--target': 'target', '--format': 'format', '--root-length': 'rootLength', '--max-path': 'maxPath', '--exclude': 'exclude', '--plan': 'plan', '--manifest': 'manifest' };
    if (!(arg in keys)) argumentError(`Unknown option: ${arg}`);
    if (arg !== '--exclude' && seen.has(arg)) argumentError(`Duplicate option: ${arg}`);
    seen.add(arg);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) argumentError(`Missing value for ${arg}.`);
    nonemptyString(value, `Value for ${arg}`);
    if (arg === '--exclude') options.exclude.push(validateRelativePath(value, 'Exclusion'));
    else options[keys[arg]] = value;
  }
  if (!['windows', 'macos', 'posix'].includes(options.target)) argumentError('Target must be windows, macos, or posix.');
  if (!['text', 'json', 'markdown'].includes(options.format)) argumentError('Format must be text, json, or markdown.');
  options.rootLength = integer(String(options.rootLength), '--root-length', 0);
  options.maxPath = integer(String(options.maxPath), '--max-path', 1);
  if (options.plan && options.manifest) argumentError('--plan and --manifest are mutually exclusive.');
  if ((options.plan || options.manifest) && options.directories.length) argumentError('--plan and --manifest cannot be combined with directory arguments.');
  if (options.manifest && (options.exclude.length || options.includeDefaults)) argumentError('Exclusion options require directory or plan mode.');
  return options;
}

async function readJson(filename, kind) {
  let text;
  let bytes;
  try { bytes = await readFile(filename); }
  catch (error) { throw new Error(`Cannot read ${kind} file (${error.code ?? 'read error'}).`); }
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${kind[0].toUpperCase() + kind.slice(1)} file must be valid UTF-8.`); }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Invalid JSON in ${kind} file.`); }
}

function planSources(plan, filename) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.sources) || plan.sources.length === 0) argumentError('Plan must be an object with a nonempty sources array.');
  const labels = new Set();
  return plan.sources.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) argumentError(`Plan source ${index + 1} must be an object.`);
    const from = nonemptyString(item.from, `Plan source ${index + 1} from`);
    const to = item.to === undefined ? '' : validateRelativePath(item.to, `Plan source ${index + 1} to`, { empty: true });
    const source = item.label === undefined ? `source-${index + 1}` : nonemptyString(item.label, `Plan source ${index + 1} label`);
    if (labels.has(source)) argumentError(`Plan labels must be unique: ${JSON.stringify(source)}.`);
    labels.add(source);
    return { directory: path.resolve(path.dirname(filename), from), source, to };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  if (options.version) {
    const packageFile = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  let entries;
  if (options.manifest) {
    const manifest = await readJson(options.manifest, 'manifest');
    entries = Array.isArray(manifest) ? manifest : manifest?.entries;
    if (!Array.isArray(entries)) argumentError('Manifest must be an entries array or an object with an entries array.');
  } else {
    const sources = options.plan
      ? planSources(await readJson(options.plan, 'plan'), path.resolve(options.plan))
      : (options.directories.length ? options.directories : ['.']).map((directory, index) => ({ directory, source: `source-${index + 1}`, to: '' }));
    const exclude = options.includeDefaults ? options.exclude : ['.git', 'node_modules', ...options.exclude];
    entries = [];
    for (const source of sources) {
      const scanned = await scanDirectory(source.directory, { source: source.source, to: source.to, exclude, maxEntries: Math.max(1, 100000 - entries.length) });
      if (entries.length + scanned.length > 100000) throw new Error('Combined scan entry limit (100000) exceeded.');
      entries.push(...scanned);
    }
  }
  const report = audit(entries, { target: options.target, rootLength: options.rootLength, maxPath: options.maxPath });
  const output = { text: formatText, json: formatJson, markdown: formatMarkdown }[options.format](report);
  process.stdout.write(output);
  process.exitCode = report.summary.errors > 0 || (options.strict && report.summary.warnings > 0) ? 1 : 0;
}

main().catch((error) => {
  // One escaped line keeps filenames and labels from controlling the terminal.
  const message = String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  process.stderr.write(`carrycheck: ${message}\n`);
  process.exitCode = 2;
});
