# dsh-safe · Startup Fuse for dsh

[中文](./README.md) | English

When a community plugin of DeepSeek Harness (DSH) is incompatible with the dsh runtime, `dsh web` **fails to boot entirely** — the loader flattens all patch layers into a single load tree, so if any plugin fails to import, throws inside `apply`, or times out waiting for an injected service, the boot audit rejects the whole tree and the process exits. The only remedy was manually editing `cordis.patch.yml` to disable the broken plugin.

**dsh-safe automates that manual step**: it wraps `dsh`, identifies the offending plugin from the startup error, sets the matching row to `disabled: true` in the profile patch (recording it in a quarantine ledger), and retries automatically. A broken plugin only breaks itself; dsh boots as usual.

## Installation

```bash
npm install -g @hyzyn/dsh-safe
```

Requires Node >= 20 and a local `dsh` command. Zero runtime dependencies.

## Quick Start

Just replace `dsh` with `dsh-safe`:

```bash
dsh-safe web          # same as dsh web, with auto-quarantine
dsh-safe --profile tui --patch ./extra.yml
```

Sample output (shown with a zh locale: a broken plugin is quarantined, then startup retries):

```
Error: dsh: plugin tree failed to load: failed to apply loader entry smoke-broken (@smoke/broken-impl): Cannot find package '@smoke/broken-impl' ...
[dsh-safe] 已禁用 @smoke/broken-impl (id: smoke-broken) → /Users/me/.dsh/profiles/web/cordis.patch.yml
           原因: Error: failed to import loader entry smoke-broken (@smoke/broken-impl): Cannot find package …
[dsh-safe] 重试启动…
```

## Commands

```
dsh-safe <dsh args…>              wrap and run dsh
dsh-safe list [--profile <name>]  show quarantined plugins (defaults to all profiles)
dsh-safe restore --profile <name> (--id <id> | --all) [--dry-run]
                                  re-enable auto-disabled plugins (after a fixed plugin upgrade)
dsh-safe update [-y] [--to <ver>] [--no-restore] [--pm npm|pnpm]
                                  upgrade dsh and auto-restore quarantined plugins
dsh-safe help
```

Wrapper-mode options (must come before the profile / subcommand):

| Option | Description |
| --- | --- |
| `--dry-run` | Parse and report only; no files are modified |
| `--max-retries <n>` | Max startup retries after an auto-quarantine (default 2; `0` means pass through without quarantining) |
| `--allow-first-party` | Allow auto-disabling first-party `@deepseek-ai/*` plugins (skipped by default; handle manually) |

Upgrading dsh: `dsh-safe update` auto-detects the dsh package name and install method (npm / pnpm global installs), compares against the latest version and runs the upgrade for you, then automatically restores all quarantined plugins — any still incompatible under the new dsh will be auto-quarantined again on the next start. `--to <version>` pins a target version (also how you roll back), `--no-restore` skips the restore, `-y` skips the confirmation.

Messages follow `LC_ALL` / `LC_MESSAGES` / `LANG` / `LANGUAGE` (`zh*` → Chinese, otherwise English); force with `DSH_SAFE_LANG=zh|en`.

## How It Works

1. **Failure identification**: when dsh fails to start, stderr carries four kinds of signatures (`plugin(s) failed to load: …`, `N entries did not activate` with per-row failures, `failed to apply/import loader entry <id> (<name>)`, and outer stack frames `…#<entryId>`). dsh-safe extracts the broken plugin's package name and row id from them.
2. **Match against real rows**: it scans the profile patch, `$DSH_HOME/cordis.patch.yml` (home layer) and each bundle's patch to build a "row id ↔ plugin package" mapping; only rows that actually exist are disabled, avoiding collateral damage.
3. **Managed block writing**: it appends a marker-commented managed block at the end of the matching patch file (same convention as `dsh-mcp-config managed`), setting matched rows to `disabled: true`. Existing user content and comments are preserved; a fresh profile's `[]` template is correctly replaced with a block sequence.
4. **Ledger & restore**: quarantine records live in `$DSH_HOME/dsh-safe/quarantine.json`. Once a plugin upgrade fixes the issue, `dsh-safe restore --profile web --all` removes the managed block and re-mounts the plugin (hot-applied for profiles with `patchReload: live`).

## Safety Boundaries

- **First-party protection**: rows of `@deepseek-ai/*` plugins are skipped by default (disabling plugins like `dsh-web-app` would strip dsh of its core capabilities); pass `--allow-first-party` to touch them.
- **Startup-phase failures only**: module resolution failures / `apply` throws / timed-out service injection. Uncaught runtime exceptions are still handled by dsh's own fail-loud policy and are out of scope for boot quarantine.
- **Auditable**: every write records the reason and a timestamp; `--dry-run` previews which plugins would be disabled.
- **Faithful pass-through**: when no broken plugin can be identified, the retry limit is exceeded, or for `dsh plugin` (pnpm forwarding), the exit code is passed through untouched and no files are modified.

## Known Limitations

- If the patch file itself fails YAML parsing (e.g. broken by hand-editing), plugins cannot be identified and the failure is passed through.
- Rows inserted via `--patch` overlay layers are not part of the mapping (only the profile patch, the home patch and bundle patches are scanned).
- To capture stderr, the wrapper pipes dsh's stderr (content is still echoed to the terminal in real time); stdout/stdin pass through unaffected.
- Match patterns target the dsh 0.1.x error formats; a major dsh upgrade that changes them requires updating the parser.

## Development

```bash
npm test        # node:test unit tests + fake-dsh integration tests
```

## License

[MIT](./LICENSE)
