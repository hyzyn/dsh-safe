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

Just swap `dsh` for `dsh-safe` — `-u` (update-and-boot) is recommended: when dsh has a new version it upgrades and restores quarantined plugins first; when dsh is already latest it behaves exactly like a plain start:

```bash
dsh-safe -u web       # recommended: update then boot (with auto-quarantine)
dsh-safe web          # no update check, boot with auto-quarantine
dsh-safe --profile tui --patch ./extra.yml
```

`-u` adds one version check per boot (needs network; on check failure it just warns and boots anyway) — offline or scripted environments can use the second line.

Sample output (shown with a zh locale: a broken plugin is quarantined, then startup retries):

```
Error: dsh: plugin tree failed to load: failed to apply loader entry smoke-broken (@smoke/broken-impl): Cannot find package '@smoke/broken-impl' ...
[dsh-safe] 已禁用 @smoke/broken-impl (id: smoke-broken) → /Users/me/.dsh/profiles/web/cordis.patch.yml
           原因: Error: failed to import loader entry smoke-broken (@smoke/broken-impl): Cannot find package …
[dsh-safe] 重试启动…
```

## Commands & Options

### Subcommands

| Command | Description |
| --- | --- |
| `dsh-safe <dsh args…>` | wrap and run dsh (swap `dsh` for `dsh-safe`) |
| `dsh-safe -u [update options] [dsh args…]` | upgrade dsh and dsh-safe itself first (skip if latest), then boot in wrap mode; `--update` is an alias |
| `dsh-safe update [options]` | upgrade only, no boot — options below |
| `dsh-safe list [--profile <name>] [--json]` | show quarantined plugins (`--json` outputs structured JSON; defaults to all profiles) |
| `dsh-safe doctor` | environment check: versions, DSH_HOME, profiles, ledger, patch health |
| `dsh-safe restore [--profile <name>] (--id <id> \| --all) [--dry-run]` | re-enable auto-disabled plugins (omit `--profile` to cover every profile in the ledger) |
| `dsh-safe explain [--file <path>]` | interpret a failed-boot stderr with AI (read-only, needs `DSH_SAFE_AI_KEY`) |
| `dsh-safe help` (`-h` / `--help`) | show help |
| `dsh-safe --version` (`-V`) | show version |

Every short flag has an equivalent long form (`-u` = `--update`, `-y` = `--yes`, `-h` = `--help`, `-V` = `--version`); single letters use `-`, words use `--`.

### Wrapper-mode options (must come before the first positional argument)

| Option | Description |
| --- | --- |
| `--dry-run` | Parse and report only; no files are modified |
| `--max-retries <n>` | Max startup retries after an auto-quarantine (default 2; `0` means pass through without quarantining) |
| `--allow-first-party` | Allow auto-disabling first-party `@deepseek-ai/*` plugins (skipped by default; handle manually) |
| `--exclude <id-or-pkg>` | Quarantine exclusion list (repeatable) — matched rows are never auto-disabled; can also live in `config.json` |

### update / -u options (after `-u` or `update`; wrapper flags before the dsh args still apply)

| Option | Description |
| --- | --- |
| `-y` / `--yes` | Skip the upgrade confirmation (required in non-interactive terminals) |
| `--to <version>` | Target dsh version, also how you roll back (explicit downgrades allowed); dsh-safe itself always upgrades to the latest |
| `--self` | Update dsh-safe itself only; dsh and quarantine state untouched |
| `--no-restore` | Do not auto-restore quarantined plugins after upgrading dsh |
| `--no-verify` | Skip the post-upgrade parser self-check (boots the new dsh with a throwaway profile to confirm error recognition still works) |
| `--pm <npm\|pnpm>` | Force the package manager (auto-detected by default) |

### Environment variables

| Variable | Description |
| --- | --- |
| `DSH_SAFE_LANG=zh\|en` | Force message language (defaults to `LC_ALL` / `LC_MESSAGES` / `LANG` / `LANGUAGE`) |
| `DSH_SAFE_NO_UPDATE_CHECK=1` | Disable the at-most-daily dsh-safe new-version notice on boot |
| `DSH_HOME` | dsh home directory (dsh's own variable; the quarantine ledger and patch paths follow it) |
| `DSH_SAFE_AI_KEY` | AI feature key (unset = AI disabled entirely); defaults to DeepSeek |
| `DSH_SAFE_AI_BASE_URL` | AI endpoint (OpenAI-compatible), default `https://api.deepseek.com` |
| `DSH_SAFE_AI_MODEL` | AI model, default `deepseek-chat` |
| `DSH_SAFE_AI_RECOVER=1` | enable AI fallback when regex signatures can't identify the broken plugin (results go through the same quarantine pipeline) |

How upgrading works: `dsh-safe update` auto-detects the dsh package name and install method (npm / pnpm global installs), compares against the latest version and runs the upgrade for you, then automatically restores all quarantined plugins — any still incompatible under the new dsh will be auto-quarantined again on the next start. For daily use, just make `dsh-safe -u web` your start command: boots immediately when dsh is already latest (one version check), upgrades + restores first when an update is available, and only warns (still boots) if the update check itself fails. `-u` accepts update options (e.g. `-u -y web`) and wrapper flags (e.g. `-u --max-retries 0 web`).

## How It Works

1. **Failure identification**: when dsh fails to start, stderr carries four kinds of signatures (`plugin(s) failed to load: …`, `N entries did not activate` with per-row failures, `failed to apply/import loader entry <id> (<name>)`, and outer stack frames `…#<entryId>`). dsh-safe extracts the broken plugin's package name and row id from them.
2. **Match against real rows**: it scans the profile patch, `$DSH_HOME/cordis.patch.yml` (home layer) and each bundle's patch to build a "row id ↔ plugin package" mapping; only rows that actually exist are disabled, avoiding collateral damage.
3. **Managed block writing**: it appends a marker-commented managed block at the end of the matching patch file (same convention as `dsh-mcp-config managed`), setting matched rows to `disabled: true`. Existing user content and comments are preserved; a fresh profile's `[]` template is correctly replaced with a block sequence.
4. **Ledger & restore**: quarantine records live in `$DSH_HOME/dsh-safe/quarantine.json`. Once a plugin upgrade fixes the issue, `dsh-safe restore --profile web --all` removes the managed block and re-mounts the plugin (hot-applied for profiles with `patchReload: live`).

### AI Capabilities (optional)

Enabled by setting `DSH_SAFE_AI_KEY` (defaults to DeepSeek; OpenAI-compatible — swap providers via `DSH_SAFE_AI_BASE_URL` / `DSH_SAFE_AI_MODEL`):

- **`dsh-safe explain [--file <path>]`**: feed it a failed-boot stderr (stdin or file) and get a plain-language interpretation plus fix suggestions. Strictly read-only.
- **AI fallback identification** (`DSH_SAFE_AI_RECOVER=1`): when the regex signatures can't identify the broken plugin (e.g. after a dsh upgrade changes formats), the AI picks the culprit from the stderr — **its output must pass the exact same validation pipeline** (match against real patch rows, first-party protection, dry-run preview); unmatched picks are passed through as before. Only invoked on startup failure.
- Privacy: home paths are redacted to `~` before sending; any AI failure degrades silently.

## Safety Boundaries

- **First-party protection**: rows of `@deepseek-ai/*` plugins are skipped by default (disabling plugins like `dsh-web-app` would strip dsh of its core capabilities); pass `--allow-first-party` to touch them.
- **Startup-phase failures only**: module resolution failures / `apply` throws / timed-out service injection. Uncaught runtime exceptions are still handled by dsh's own fail-loud policy and are out of scope for boot quarantine.
- **Auditable**: every write records the reason and a timestamp; `--dry-run` previews which plugins would be disabled.
- **Faithful pass-through**: when no broken plugin can be identified, the retry limit is exceeded, or for `dsh plugin` (pnpm forwarding), the exit code is passed through untouched and no files are modified.

## Known Limitations

- If the patch file itself fails YAML parsing (e.g. broken by hand-editing), plugins cannot be identified and the failure is passed through.
- Rows inserted via `--patch` overlay layers are not part of the mapping (only the profile patch, the home patch and bundle patches are scanned).
- To capture stderr, the wrapper pipes dsh's stderr (content is still echoed to the terminal in real time); stdout/stdin pass through unaffected.
- Match patterns target the dsh 0.1.x error formats; a major dsh upgrade that changes them requires updating the parser. Mitigation: after update/-u upgrades dsh it runs a parser self-check — boots the new dsh with a throwaway profile and confirms failures are still recognized, warning right away on mismatch (`--no-verify` skips it).
- Windows is best-effort: update / --self / list / restore are adapted (.cmd shim parsing, shelled npm/pnpm invocations); the wrapped boot resolves the node entry embedded in dsh's .cmd/.ps1 shim on PATH and spawns `node <entry>` directly (.exe runs as-is, unparseable shims fall back to a shelled spawn), sidestepping Node's ban on spawning .cmd files. Not yet verified end-to-end on a real Windows machine — feedback welcome.

## Development

```bash
npm test        # node:test unit tests + fake-dsh integration tests
```

## License

[MIT](./LICENSE)
