# Contributing

CarryCheck focuses on read-only preflight checks for directory handoffs and multi-source overlays. Useful contributions include small reproducible cases, clearer findings, documentation, and narrowly scoped portability rules.

## Local development

Use Node.js 22 or newer. There are no dependencies or build steps.

```sh
npm test
npm run check
```

`npm run demo` exercises deliberately problematic input and returns exit code 1. A normal test/check run should return 0.

## Propose a change

1. Describe the handoff or merge that fails, the target platform/tool, and the expected result.
2. Prefer a tiny offline JSON manifest with invented names to sharing private source trees. Include the command, Node.js version, and output.
3. For behavior changes, add an independent regression case that checks observable findings and exit status. Use virtual manifests for names the host cannot create.
4. Keep the English and Chinese READMEs aligned when changing CLI behavior. Explain policy choices and cite primary platform documentation for new platform rules.
5. Run the tests and repository audit, then open a focused pull request with the validation results.

Host symlink tests can skip when the operating system denies symlink creation; virtual link-analysis cases must still run. The CI matrix covers Node.js 22 and 24 on Ubuntu, Windows, and macOS.

## Design boundaries

Preserve zero runtime dependencies, deterministic machine-readable reports, source attribution, and read-only scanning. Do not follow host symlinks or add automatic copy/rename behavior as a side effect of auditing. Treat profile comparison and path budgets as documented policies rather than complete filesystem emulation.

Schema version 1 and finding codes are integration surfaces. Discuss incompatible changes before implementing them. Never include credentials, real private filenames, or file contents in fixtures or bug reports.

For security-sensitive reports, see [SECURITY.md](SECURITY.md). Contributions are distributed under the repository's [MIT license](LICENSE).
