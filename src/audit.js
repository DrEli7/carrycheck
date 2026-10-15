const TARGETS = new Set(['windows', 'macos', 'posix']);
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const ref = (entry) => ({ path: entry.path, source: entry.source });

function validate(entries, options) {
  if (!Array.isArray(entries) || entries.length > 100000) throw new Error('Entries must be an array of at most 100000 items.');
  if (!TARGETS.has(options.target)) throw new Error('Unknown target profile.');
  for (const [key, minimum] of [['rootLength', 0], ['maxPath', 1]]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < minimum) throw new Error(`${key} must be a safe integer >= ${minimum}.`);
  }
  let textUnits = 0;
  return entries.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Entry ${index + 1} must be an object.`);
    const name = item.path;
    if (typeof name !== 'string' || !name || !name.isWellFormed() || name.includes('\0')) throw new Error(`Entry ${index + 1} needs a nonempty Unicode path without NUL.`);
    if (/^[/\\]|^[a-z]:/i.test(name) || name.split('/').some((part) => ['', '.', '..'].includes(part))) throw new Error(`Entry ${index + 1} path must be relative, slash-delimited, without empty, dot or parent components.`);
    const type = item.type ?? 'file';
    if (!['file', 'directory', 'symlink'].includes(type)) throw new Error(`Entry ${index + 1} has an unsupported type.`);
    const source = item.source ?? 'source-1';
    if (typeof source !== 'string' || !source || !source.isWellFormed() || source.includes('\0')) throw new Error(`Entry ${index + 1} needs a valid source label.`);
    if (type === 'symlink' && (typeof item.linkTarget !== 'string' || !item.linkTarget || !item.linkTarget.isWellFormed() || item.linkTarget.includes('\0'))) throw new Error(`Symlink entry ${index + 1} needs a valid linkTarget.`);
    if (name.length > 32768 || name.split('/').length > 256 || source.length > 256 || (type === 'symlink' && (item.linkTarget.length > 32768 || item.linkTarget.split('/').length > 256))) throw new Error(`Entry ${index + 1} exceeds an analysis limit (32768-unit paths/links, 256 components or 256-unit source labels).`);
    textUnits += name.length + source.length + (type === 'symlink' ? item.linkTarget.length : 0);
    if (textUnits > 16000000) throw new Error('Input exceeds the 16000000-unit textual analysis limit.');
    return { path: name, source, type, ...(type === 'symlink' ? { linkTarget: item.linkTarget } : {}) };
  });
}

/** Model target names conservatively; this is not an NTFS or APFS emulator. */
function keyFor(name, target) {
  if (target === 'posix') return name;
  return name.split('/').map((part) => {
    const normalized = part.normalize('NFC').toLowerCase();
    return target === 'windows' ? normalized.replace(/[ .]+$/u, '') : normalized;
  }).join('/');
}

/** Audit a virtual destination tree. Never reads or changes the filesystem. */
export function audit(input, configuration = {}) {
  const options = { target: 'windows', rootLength: 40, maxPath: 259, ...configuration };
  const entries = validate(input, options);
  const { target, rootLength, maxPath } = options;
  const units = (value) => target === 'windows' ? value.length : Buffer.byteLength(value, 'utf8');
  const findings = [];
  const add = (code, severity, message, paths, hint) => {
    const unique = new Map(paths.map((item) => [JSON.stringify([item.path, item.source]), ref(item)]));
    findings.push({ code, severity, message, paths: [...unique.values()].sort((a, b) => compare(a.path, b.path) || compare(a.source, b.source)), hint });
  };

  // Materialize ancestors so a file can conflict with an implied directory.
  const nodes = new Map();
  function insert(name, type, origin, explicit) {
    let node = nodes.get(name);
    if (!node) {
      if (nodes.size >= 200000) throw new Error('Input exceeds the 200000-node virtual tree analysis limit.');
      node = { name, types: new Set(), origins: new Map(), explicit: [] };
      nodes.set(name, node);
    }
    node.types.add(type);
    if (!node.origins.has(origin.source)) node.origins.set(origin.source, { path: name, source: origin.source });
    if (explicit) node.explicit.push(origin);
  }
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) insert(parts.slice(0, i).join('/'), 'directory', entry, false);
    insert(entry.path, entry.type, entry, true);
  }

  const projected = new Map();
  for (const node of nodes.values()) {
    const key = keyFor(node.name, target);
    const origins = [...node.origins.values()];
    if (!projected.has(key)) projected.set(key, []);
    projected.get(key).push(node);
    const component = node.name.split('/').at(-1);
    if (target === 'windows') {
      if (WINDOWS_RESERVED.test(component.split('.')[0].replace(/ +$/u, ''))) add('WINDOWS_RESERVED', 'error', 'A component is a reserved Windows device name, including when used with an extension.', origins, 'Rename this file or directory before handing it to Windows users.');
      if (/[<>:"\\|?*\x00-\x1f]/u.test(component)) add('WINDOWS_CHARACTER', 'error', 'A component contains a character rejected by common Windows file APIs.', origins, 'Choose a name without Windows-reserved punctuation or control characters.');
      if (/[ .]$/u.test(component)) add('WINDOWS_TRAILING', 'error', 'A component ends in a dot or space that Windows tools may strip or reject.', origins, 'Remove the trailing dot or space and check the new name for collisions.');
    }
    if (INVISIBLE.test(component)) add('INVISIBLE_NAME', 'warning', 'A component contains an invisible, control, or formatting character.', origins, 'Inspect the escaped spelling; remove invisible characters if they are unintended.');
    if (target !== 'posix' && component !== component.normalize('NFC')) add('NON_NFC_NAME', 'warning', 'A component uses decomposed Unicode spelling.', origins, 'Check references before normalizing names to NFC; normalization can create collisions.');
    if (units(component) > 255) add('COMPONENT_BUDGET', 'error', 'A component exceeds the selected 255-unit portability budget.', origins, `Shorten this component. The ${target} profile measures ${target === 'windows' ? 'UTF-16 code units' : 'UTF-8 bytes'}.`);
    if (node.explicit.filter((item) => item.type !== 'directory').length > 1 && node.types.size === 1) add('OVERWRITE', 'error', 'Multiple source entries occupy the same destination name.', node.explicit, 'Place sources under separate mount points or decide explicitly which file to keep. Content equality is not checked.');
  }

  for (const group of projected.values()) {
    const types = new Set(group.flatMap((node) => [...node.types]));
    if (types.size > 1) add('TYPE_CONFLICT', 'error', 'A destination is required to be incompatible entry types (including implied directories).', group.flatMap((node) => [...node.origins.values()]), 'Move or rename a source entry so a file or symlink is never used as a directory.');
    if (group.length < 2) continue;
    const basenames = [...new Set(group.map((node) => node.name.split('/').at(-1)))];
    // Ancestor aliases already explain descendants with identical basenames.
    if (basenames.length < 2) {
      const leaves = group.flatMap((node) => node.explicit.filter((item) => item.type !== 'directory'));
      if (leaves.length > 1) add('OVERWRITE', 'error', 'Merging aliased parent directories would overwrite the same destination entry.', leaves, 'Keep these sources under separate mount points or rename one entry before merging.');
      continue;
    }
    let code = 'CASE_COLLISION';
    if (new Set(basenames.map((name) => name.normalize('NFC'))).size === 1) code = 'UNICODE_COLLISION';
    else if (target === 'windows' && new Set(basenames.map((name) => name.normalize('NFC').toLowerCase())).size > 1) code = 'WINDOWS_ALIAS_COLLISION';
    add(code, 'error', `Different spellings map to the same destination under the ${target} profile.`, group.flatMap((node) => [...node.origins.values()]), 'Rename colliding entries or mount their sources under distinct destination directories.');
  }

  let longestRelativePath = 0;
  for (const entry of entries) {
    const length = units(entry.path);
    longestRelativePath = Math.max(longestRelativePath, length);
    if (rootLength + 1 + length > maxPath) add('PATH_BUDGET', 'error', `The projected full path needs ${rootLength + 1 + length} units; the configured budget is ${maxPath}.`, [entry], 'Shorten the destination root or the relative path, or deliberately choose a larger toolchain budget.');
  }

  const resolveLink = (entry) => {
    const visited = new Set();
    const stack = [];
    const pending = entry.path.split('/');
    let hops = 0;
    while (pending.length) {
        const component = pending.shift();
        if (component === '' || component === '.') continue;
        if (component === '..') {
          if (!stack.length) return ['SYMLINK_ESCAPE', 'A symlink chain escapes the virtual destination root.'];
          stack.pop();
          continue;
        }
        const prefix = [...stack, component].join('/');
        const candidates = projected.get(keyFor(prefix, target));
        if (!candidates) return ['SYMLINK_DANGLING', 'The symlink target is absent from the projected destination.'];
        if (candidates.length !== 1 || candidates[0].types.size !== 1 || candidates[0].explicit.filter((item) => item.type !== 'directory').length > 1) return ['SYMLINK_AMBIGUOUS', 'The symlink crosses a destination with conflicting entries.'];
        const node = candidates[0];
        if (node.types.has('symlink')) {
          const link = node.explicit.find((item) => item.type === 'symlink');
          const state = JSON.stringify([stack, pending, link.path]);
          if (visited.has(state)) return ['SYMLINK_CYCLE', 'The projected symlink chain contains a cycle.'];
          visited.add(state);
          if (++hops > 64) return ['SYMLINK_DEPTH', 'The symlink chain exceeds the 64-hop analysis limit.'];
          const linkName = link.linkTarget;
          if (/^[/\\]|^[a-z]:/i.test(linkName)) return ['SYMLINK_ABSOLUTE', 'An absolute symlink depends on a location outside the handoff.'];
          if (linkName.includes('\\')) return ['SYMLINK_SEPARATOR', 'A symlink target uses backslashes with platform-dependent meaning.'];
          // Expand links before interpreting later '..' components, as a real
          // filesystem does. Lexical normalization here would hide escapes.
          pending.unshift(...linkName.split('/'));
          continue;
        }
        if (pending.length && !node.types.has('directory')) return ['SYMLINK_DANGLING', 'The symlink target traverses a non-directory entry.'];
        stack.push(component);
    }
    return null;
  };
  for (const entry of entries.filter((item) => item.type === 'symlink')) {
    add('SYMLINK_PORTABILITY', 'warning', 'Symlink support and archive behavior depend on the receiving tool and operating system.', [entry], 'Verify that your copy or archive tool preserves links, or replace links with ordinary files before handoff.');
    const issue = resolveLink(entry);
    if (issue) add(issue[0], 'error', issue[1], [entry], 'Use a relative link whose entire target chain is included in the destination, or replace the link before handoff.');
  }

  findings.sort((a, b) => compare(a.severity === 'error' ? 0 : 1, b.severity === 'error' ? 0 : 1) || compare(a.code, b.code) || compare(JSON.stringify(a.paths), JSON.stringify(b.paths)));
  return {
    schemaVersion: 1, target,
    summary: { entries: entries.length, errors: findings.filter((item) => item.severity === 'error').length, warnings: findings.filter((item) => item.severity === 'warning').length },
    budget: { maxPath, rootLength, unit: target === 'windows' ? 'utf16' : 'utf8', longestRelativePath, remainingRootBudget: entries.length ? maxPath - 1 - longestRelativePath : maxPath },
    findings
  };
}
