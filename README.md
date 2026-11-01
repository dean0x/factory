# factory

Set up and run a node of Claude Code lanes with safe defaults.

A node is a folder with a config file, a `CLAUDE.md` for the coordinator, and a `.factory/` folder for the state. This version (0.1.0) creates and checks a node. It does not start lanes yet.

## Install

```sh
npm install --global @dean0x/factory
```

Node.js 22 or newer is required. The package has no runtime dependencies.

## Commands

| Command | What it does |
| --- | --- |
| `factory init` | Create a node in a folder. It writes `factory.yaml`, `CLAUDE.md` and `.factory/`, and makes the first commit in the state repository. |
| `factory doctor` | Run eleven checks on the config, the state, the managed blocks, the secrets, the proxy settings, the tools and the projects. |
| `factory upgrade` | Migrate the config and the state to this version, and refresh the managed blocks. |
| `factory version` | Print the version. |
| `factory help` | Show the help. |

Run `factory <command> --help` to see the flags of one command. All commands take `--json`, `--quiet` and `--no-color`.

### Create a node

```sh
factory init --home ./node --name demo --owner-name "Your Name" --project ../web
factory doctor --home ./node
```

`init` stops when the folder has a `factory.yaml` already. If a parent folder has one, `init` works and prints a warning. Commands other than `init` find the nearest `factory.yaml` above the current folder, unless you give `--home`.

### Upgrade a node

```sh
factory upgrade --dry-run
factory upgrade
```

`upgrade` backs up `factory.yaml`, `CLAUDE.md` and `.factory/` to `.factory/backups/<timestamp>/`. It restores the files when a step fails. It never replaces a managed block that you edited. To replace such a block with the template text, name it:

```sh
factory upgrade --overwrite coordinator
```

## Managed blocks

`init` writes text blocks between markers in `CLAUDE.md` and `.factory/protocol.md`:

```
<!-- factory:begin NAME vN sha256=HASH -->
...
<!-- factory:end NAME -->
```

The hash lets `factory` find out that a person edited a block. Text outside the markers is yours. `factory` keeps it.

## Safety defaults

- The permission mode is `auto`. `doctor` fails when a settings file in the node folder skips the permission prompts.
- A proxy comes only from the config. `doctor` checks that it answers. A stray `ANTHROPIC_BASE_URL` in the shell is a warning.
- Merges and releases wait for the owner.
- `doctor` fails when a value in `factory.yaml` looks like a token. It never prints the value.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. Warnings keep exit code 0. |
| 1 | The command failed, or a check failed. |
| 2 | The command line is wrong. |
| 3 | Not ready. No command uses this code yet. |
| 4 | A safety rule refused the action. |

## Development

```sh
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run test:integration
npm run exit-check
```

The integration tests and the exit check use `dist/factory.js`, so run `npm run build` first. The exit check packs the tarball and installs it in a throw-away HOME. It never writes the real HOME.

## License

MIT
