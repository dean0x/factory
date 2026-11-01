# Changelog

## 0.1.0 (not released)

- `factory init` creates a node: `factory.yaml`, `CLAUDE.md` and a `.factory/` state folder with its own git repository. It writes `CLAUDE.md` and `factory.yaml` in one step each. If a step fails, it removes only what it made, and the error names each step that it could not undo.
- `factory doctor` runs eleven checks and exits 1 when one fails.
- `factory upgrade` migrates the config and the state, and refreshes the managed blocks. It backs up first, keeps the last 5 backups, and restores the files when a step fails. The error names each file that it could not restore.
- `factory version` and `factory help`.
- Schemas with a version for `factory.yaml` and `.factory/node.json`, and a migration runner.
- Managed blocks in `CLAUDE.md` and `.factory/protocol.md`. A block that a person edited is never replaced without `--overwrite`.
- A secret scan of the config, and a proxy URL check with a health check.
