import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

// A BOM is part of a filename, not an encoding marker to remove.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function validString(value, name, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.length === 0) || !value.isWellFormed() || value.includes('\0')) {
    throw new TypeError(`${name} must be ${empty ? 'a' : 'a nonempty'} well-formed string without NUL.`);
  }
}

/** Validate a forward-slash relative mount or exclusion without changing its spelling. */
export function validateRelativePath(value, name = 'Path', { empty = false } = {}) {
  validString(value, name, { empty });
  if (value === '' && empty) return value;
  if (value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`${name} must be a relative path using forward slashes, without empty, . or .. segments.`);
  }
  return value;
}

function decode(value, location) {
  try {
    const result = utf8.decode(value);
    validString(result, 'Filesystem name');
    return result;
  } catch {
    throw new Error(`Cannot scan ${JSON.stringify(location)}: a filesystem name or link target is not valid UTF-8.`);
  }
}

function sameEntry(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/**
 * Read directory names and metadata only. Symlinks are recorded, never traversed.
 * Sources must stay stable during a scan; this is not a race-proof security boundary.
 */
export async function scanDirectory(directory, { source = 'source', to = '', exclude = [], maxEntries = 100000 } = {}) {
  validString(directory, 'Directory');
  validString(source, 'Source label');
  validateRelativePath(to, 'Mount path', { empty: true });
  if (!Array.isArray(exclude)) throw new TypeError('Exclusions must be an array of relative paths or basenames.');
  const excluded = exclude.map((value) => validateRelativePath(value, 'Exclusion'));
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive safe integer.');

  const entries = [];
  const absoluteRoot = path.resolve(directory);
  const display = (relative) => `${source}${relative ? `/${relative}` : ''}`;
  const io = async (action, relative, operation) => {
    try { return await operation(); }
    catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : '';
      throw new Error(`Cannot ${action} ${JSON.stringify(display(relative))}${code}.`, { cause: error });
    }
  };
  const add = (relative, type, linkTarget) => {
    if (entries.length >= maxEntries) throw new Error(`Scan entry limit (${maxEntries}) exceeded for ${JSON.stringify(source)}.`);
    const entry = { path: to ? (relative ? `${to}/${relative}` : to) : relative, source, type };
    if (entry.path.length > 32768 || entry.path.split('/').length > 256) throw new Error('Projected path exceeds the analysis limit (32768 units or 256 components).');
    if (linkTarget !== undefined) entry.linkTarget = linkTarget;
    entries.push(entry);
  };
  const isExcluded = (relative, basename) => excluded.some((value) => value.includes('/') ? (relative === value || relative.startsWith(`${value}/`)) : value === basename);
  const stat = (absolute, relative) => io('inspect', relative, () => lstat(absolute, { bigint: true }));
  const assertUnchanged = async (absolute, relative, before) => {
    const after = await stat(absolute, relative);
    if (!sameEntry(before, after)) throw new Error(`Source changed while scanning ${JSON.stringify(display(relative))}; retry with a stable source tree.`);
  };

  const rootStat = await stat(absoluteRoot, '');
  if (rootStat.isSymbolicLink()) throw new Error(`Source root ${JSON.stringify(source)} is a symlink; choose its real directory explicitly.`);
  if (!rootStat.isDirectory()) throw new Error(`Source root ${JSON.stringify(source)} must be a directory.`);
  if (to) add('', 'directory');

  const walk = async (absolute, relative, before) => {
    const names = await io('read directory', relative, () => readdir(absolute, { encoding: 'buffer' }));
    // Check the directory identity before resolving any children from its listing.
    await assertUnchanged(absolute, relative, before);
    names.sort(Buffer.compare);
    for (const nameBuffer of names) {
      const name = decode(nameBuffer, display(relative));
      const childRelative = relative ? `${relative}/${name}` : name;
      if (isExcluded(childRelative, name)) continue;
      const childAbsolute = path.join(absolute, name);
      const childStat = await stat(childAbsolute, childRelative);
      if (childStat.isSymbolicLink()) {
        const targetBuffer = await io('read symlink', childRelative, () => readlink(childAbsolute, { encoding: 'buffer' }));
        const target = decode(targetBuffer, display(childRelative));
        await assertUnchanged(childAbsolute, childRelative, childStat);
        add(childRelative, 'symlink', target);
      } else if (childStat.isDirectory()) {
        add(childRelative, 'directory');
        await walk(childAbsolute, childRelative, childStat);
      } else if (childStat.isFile()) {
        add(childRelative, 'file');
      } else {
        throw new Error(`Unsupported filesystem entry at ${JSON.stringify(display(childRelative))}; only files, directories and symlinks can be audited.`);
      }
    }
    await assertUnchanged(absolute, relative, before);
  };

  await walk(absoluteRoot, '', rootStat);
  return entries;
}
