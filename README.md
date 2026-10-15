# CarryCheck

**Find directory handoff and merge problems before you copy anything.**

[中文说明](README.zh-CN.md) · [MIT license](LICENSE) · Node.js 22+ · Zero dependencies

Two folders can each look fine and still collide when their contents land in one destination. CarryCheck projects one or more source trees into a virtual destination and reports overwrites, incompatible names, path budgets, and fragile links—with the source of each problem attached.

Use it before combining release outputs, handing a dataset to a colleague, or sending a project to another operating system. It reads names, metadata, and symlink target text; it never copies, renames, deletes, or reads regular file contents. Plan and manifest JSON files are read when supplied.

## Try it

```sh
git clone https://github.com/DrEli7/carrycheck.git
cd carrycheck
node bin/carrycheck.js . --target windows
node bin/carrycheck.js --plan examples/merge-plan.json
node bin/carrycheck.js --manifest examples/problem-manifest.json --format json
```

The last two examples deliberately contain conflicts and exit with code **1**. `npm run demo` also intentionally exits with **1**. No dependency installation or build step is required. To put the local checkout on your command path, optionally run `npm install -g .`, then use `carrycheck`.

## Check a proposed merge

```sh
node bin/carrycheck.js ./release-a ./release-b --target windows
```

The **contents** of both directories overlay the same virtual root; the source directory names are not added. There is no “last source wins” rule: competing files are reported even if their contents might be identical. Identically named directories can merge.

For different destination mappings, create a JSON plan:

```json
{
  "sources": [
    { "from": "./left", "to": "reports", "label": "first" },
    { "from": "./right", "to": "reports", "label": "second" }
  ]
}
```

`from` resolves relative to the plan file, not the current working directory. Omit `to` or use `""` to mount at the virtual root. A mount uses forward slashes and cannot contain empty, `.` or `..` segments. Labels must be unique; omitted labels become `source-1`, `source-2`, and so on. Ordinary directory arguments use those anonymous labels too.

The included plan makes `first` and `second` compete for `reports/README.txt`. Its JSON report includes this finding:

```json
{
  "code": "OVERWRITE",
  "severity": "error",
  "message": "Multiple source entries occupy the same destination name.",
  "paths": [
    { "path": "reports/README.txt", "source": "first" },
    { "path": "reports/README.txt", "source": "second" }
  ],
  "hint": "Place sources under separate mount points or decide explicitly which file to keep. Content equality is not checked."
}
```

Mounting them at `reports/first` and `reports/second` instead resolves this particular collision. CarryCheck evaluates that proposed layout without creating it. To account for files already at a destination, include that directory as another source.

## Audit an offline manifest

A manifest describes the destination directly. It can represent names that your current OS cannot create, making cross-platform checks and reproducible bug reports easier.

```json
{
  "entries": [
    { "path": "docs/Readme.txt", "source": "first" },
    { "path": "docs/README.txt", "source": "second" },
    { "path": "latest", "source": "first", "type": "symlink", "linkTarget": "docs/Readme.txt" }
  ]
}
```

The top level may also be the entries array itself. Each entry needs a nonempty relative `path`; `/` separates components, and absolute paths, empty segments, `.` and `..` are rejected. `type` is `file` (default), `directory`, or `symlink`; a symlink requires `linkTarget`. The default source is `source-1`. Strings must be well-formed Unicode without NUL. Missing ancestor directories are inferred.

Manifest mode reads only that UTF-8 JSON file. It does not check whether entries exist on disk. The [problem manifest](examples/problem-manifest.json) includes case and Unicode collisions, a Windows device name, a file/directory conflict, an escaping link, and an invisible character.

## Profiles and budgets

| Profile | Destination name comparison | Length units |
| --- | --- | --- |
| `windows` (default) | NFC + JavaScript lowercase; trailing dots/spaces removed for alias checks | UTF-16 code units |
| `macos` | Conservative NFC + JavaScript lowercase | UTF-8 bytes |
| `posix` | Exact spelling | UTF-8 bytes |

Windows checks include reserved device names with extensions and superscript digits, reserved punctuation/control characters, and trailing dots/spaces. The Windows and macOS profiles warn about decomposed Unicode. All profiles check invisible/control/format characters, overwrites, entry-type conflicts, 255-unit component budgets, full-path budgets, and projected symlink chains.

These are portability policies, **not an NTFS/APFS emulator or a promise that every target tool will accept a tree**. Case-sensitive macOS volumes and case-sensitive Windows directories may behave differently. JavaScript lowercase is not a complete filesystem case-folding implementation.

The defaults `--max-path 259` and `--root-length 40` apply to **all three profiles**. They are configurable toolchain budgets, not universal operating-system or hardware limits. Modern Windows long-path support depends on application and system configuration; see [Microsoft's naming documentation](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).

For a nonempty manifest or scan:

```text
projected full path = rootLength + 1 separator + relative path length
maximum root budget = maxPath - 1 separator - longest relative path length
```

Root length excludes its final separator and uses the selected profile's units. A negative maximum root budget means the relative path alone is already too long. An empty input reports the full `maxPath` as its remaining root budget.

```sh
node bin/carrycheck.js ./dist --root-length 80 --max-path 400
node bin/carrycheck.js ./dist --target posix --max-path 4095
```

## CLI reference

```text
carrycheck [options] [directory ...]
carrycheck --plan FILE [options]
carrycheck --manifest FILE [options]
```

With no input, scan `.`. Directory, plan, and manifest modes are mutually exclusive.

| Option | Meaning |
| --- | --- |
| `--target windows\|macos\|posix` | Target profile; default `windows` |
| `--format text\|json\|markdown` | Report format; default `text` |
| `--root-length N` | Nonnegative destination root budget; default `40` |
| `--max-path N` | Positive full destination path budget; default `259` |
| `--exclude PATH` | Repeatable source-relative path/subtree or basename; no glob syntax |
| `--include-defaults` | Include the normally excluded `.git` and `node_modules` entries |
| `--strict` | Treat warnings as a failing exit status |
| `--help`, `--version` | Print help or package version |
| `--` | Treat all following arguments as directory paths |

By default, `.git` and `node_modules` are skipped at any depth. A slash-free exclusion matches a basename at any depth; a slash-containing exclusion matches that exact source-relative path and its subtree, before mount mapping. Exclusions are case-sensitive, use forward slashes, and do not read `.gitignore`. They are unavailable in manifest mode.

Reports go to stdout; input/scan errors go to stderr. JSON has `schemaVersion: 1`, `target`, `summary`, `budget`, and `findings`. Each finding includes `code`, `severity`, `message`, `paths` (with source labels), and `hint`. Reports contain relative destination names rather than absolute source roots; names and custom labels can still contain sensitive information.

```sh
node bin/carrycheck.js --plan merge.json --format json > report.json
node bin/carrycheck.js ./dist --format markdown > report.md
```

| Exit | Meaning |
| --- | --- |
| `0` | No errors; warnings are allowed unless `--strict` is set |
| `1` | At least one error, or a warning with `--strict` |
| `2` | Invalid input or a filesystem/read failure; no complete audit report |

## Limits and link behavior

- Scans require a stable source tree. Some changes are detected, but this is not a race-proof security boundary. Source roots must be real directories, not symlinks.
- Host symlinks are recorded and never traversed. Link targets are then analyzed inside the **projected destination**, including links that resolve through another source. Absolute, escaping, dangling, cyclic, ambiguous, or platform-dependent backslash targets produce errors; analysis stops after 64 link hops. Every symlink also receives a portability warning.
- Analysis is bounded to 100,000 explicit entries, 256 path segments, and 200,000 materialized virtual nodes. Additional limits apply to path/link lengths, labels, and total text input; oversized input fails before a report is produced. Unsupported special files, unreadable entries, and invalid UTF-8 filesystem names/link targets also fail the scan.
- There is no archive parsing, file hashing, content comparison, copying, permission/ACL assessment, disk-space prediction, or exact simulation of a particular copy/extraction tool. An overwrite is reported even when file bytes are equal.
- A successful audit describes the supplied inputs and policy. It does not guarantee a later copy, a mutable tree, or every receiving filesystem.

## JavaScript API

```js
import { audit, scanDirectory, formatJson } from './src/index.js';

const entries = await scanDirectory('./dist', {
  source: 'release', to: 'app', exclude: ['.git', 'node_modules']
});
const report = audit(entries, { target: 'windows', rootLength: 40, maxPath: 259 });
process.stdout.write(formatJson(report));
```

`audit()` is pure and performs no filesystem I/O. `scanDirectory()` does not add CLI default exclusions automatically. `formatText()` and `formatMarkdown()` are also exported.

## Related work

[pre-commit-hooks](https://github.com/pre-commit/pre-commit-hooks) provides case-conflict and illegal-Windows-name checks; [pathvalidate](https://github.com/thombashi/pathvalidate) validates and sanitizes individual paths; [filename-checker](https://github.com/rapjul/filename-checker) emphasizes length and SMB constraints. [rclone](https://rclone.org/commands/rclone_copy/) offers real transfers and dry runs, while [GMD](https://github.com/m5it/gmd) offers directory comparison and synchronization previews.

CarryCheck concentrates on a small workflow: map several sources into one virtual destination, assess the combined names and links for a chosen portability policy, and share the findings as text, JSON, or Markdown. The individual checks have established precedents; the project makes no uniqueness claim.

## Development

```sh
npm test
npm run check
```

CI is configured for Ubuntu, Windows, and macOS with Node.js 22 and 24. Host symlink tests may skip when Windows link privileges are unavailable; virtual-manifest link tests run independently of host privileges. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
