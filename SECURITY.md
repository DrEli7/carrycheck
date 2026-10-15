# Security

CarryCheck is a read-only planning tool. It scans directory names, metadata, and symlink target text, or reads an explicitly supplied JSON plan/manifest. It does not read regular scanned-file contents, copy files, extract archives, or contact a network service.

## Trust and scope

- Scan stable directories that you control. Identity checks detect some concurrent changes, but scanning is not a race-proof security boundary and should not be used to inspect a hostile, actively changing tree with elevated privileges.
- Source roots must be real directories. Host symlinks are recorded without traversal; link analysis uses the virtual destination tree. A reported safe link does not guarantee the behavior of a later copy/extraction tool.
- Reports omit absolute source roots by default, but relative filenames and source labels can disclose information. Review reports before sharing them. A plan can reference local paths; inspect plans from other people before running them.
- Checks use portability policies rather than exact filesystem emulation. No result guarantees that all destination applications accept the tree. No file-content or malware assessment is performed.

## Reporting a vulnerability

Use the repository's [private vulnerability reporting page](https://github.com/DrEli7/carrycheck/security/advisories/new) if available. If private reporting is unavailable, open a minimal issue asking for a private reporting channel without exploit details or sensitive data.

Include the affected version, Node.js and OS versions, a minimal manifest or invented directory layout, the command, and the expected versus observed behavior. Do not include credentials, personal paths, or private file contents. The latest published repository version is the maintenance target; no response-time guarantee is offered.
