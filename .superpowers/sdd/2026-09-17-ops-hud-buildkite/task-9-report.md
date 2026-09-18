# Task 9 report: the rename, cleanup, and docs

## What changed

### Naming / identity
- `package.json`: `name` → `ops-hud`, `version` → `2.0.0`, `bin` → `{ "ops-hud": "./dist/index.js" }`,
  `description` → `"CI and ops dashboard for the terminal — GitHub Actions and Buildkite"`,
  the `gh-hud` script entry → `ops-hud`, `repository`/`bugs`/`homepage` → `mquinnv/ops-hud`,
  added `"buildkite"` and `"ci"` to `keywords`.
- `src/cli.ts` (Ruling 1 — `program.name()` now lives here, not `src/index.ts`, which
  stays a 4-line entry unmodified): `.name("ops-hud")`, description updated to
  `"CI and ops dashboard for the terminal — GitHub Actions and Buildkite"`, and the
  `watch` subcommand description changed from "Watch GitHub workflows" to "Watch CI runs".
  `src/cli.test.ts` already used `ops-hud`/tmp-dir prefixes named `ops-hud-*` throughout —
  no stale assertion of the old name was found, so no test edit was needed there.
- `src/dashboard.ts`: title `"GitHub Workflow Monitor"` → `"Ops HUD"` (blessed screen title),
  help header → `"Ops HUD - Help"`, startup log `"GitHub HUD started"` → `"Ops HUD started"`.
- `src/dashboard.ts` help screen (Ruling 2 — provider-neutral action text): `"Dismiss
  completed workflow"` → `"Dismiss completed run"`, `"Dismiss ALL completed workflows"` →
  `"Dismiss ALL completed runs"`, `"Kill/cancel running workflow"` → `"Kill/cancel running
  run"`, `"Resurrect older workflow (undo dismiss)"` → `"Resurrect older run (undo dismiss)"`.
  Same keys, same layout. Internal code comments/event names near the key handlers (e.g.
  `// Dismiss completed workflow` above `this.screen.key(["d"], ...)`) were left alone —
  Ruling 2 named only the help-screen text, and those are internal, not user-facing.

### Config / prefs migration (new tests, new behavior)
- `src/config.ts`: `loadConfig` now takes `(configPath?, baseDir = process.cwd())`. Candidate
  order: `configPath`, `<baseDir>/.ops-hud.json`, `~/.ops-hud.json`,
  `~/.config/ops-hud/config.json`, then the three legacy `gh-hud` paths, in the same shape,
  as fallbacks. `src/app.ts`'s single-argument call to `loadConfig` is unaffected by the new
  optional parameter.
- `src/config.test.ts`: added the `"config path migration"` describe block from the brief,
  verifying the legacy `.gh-hud.json` is read when no new config exists and that
  `.ops-hud.json` wins when both exist. All pre-existing tmp-dir prefixes in this file
  (`gh-hud-test-*`) were also renamed to `ops-hud-test-*` — not exempted by Ruling 32, just
  test-fixture naming with no functional tie to the rename.
- `src/dashboard.ts` `loadPreferences`/`savePreferences`: reads `~/.ops-hud-prefs.json` if it
  exists, else falls back to reading `~/.gh-hud-prefs.json`; always **writes** the new path
  only. Comments added explaining the one-way migration.
- `src/dashboard.test.ts`: updated its top-of-file comment and `HOME` tmpdir prefix from
  `gh-hud-*` to `ops-hud-*` (not exempted; matches the renamed prefs file it's pointing at).
- `src/docker-utils.test.ts`: renamed its `gh-hud-docker-` tmpdir prefix to `ops-hud-docker-`
  (not exempted, no functional tie to the rename).
- `src/providers/github.test.ts`: the test-only scope repository `"mquinnv/gh-hud"` (used to
  build `gh api` call args and expected diagnostic messages, with no tie to the fixture
  content) was renamed to `"acme/widgets"`, consistent with `config.test.ts`'s existing
  convention. Verified this file's own suite still passes (13/13) after the change.

### Files deleted / renamed
- Deleted (all confirmed via `grep -rn` to have zero references in `src/`, `package.json`,
  `tsconfig.json`, `biome.json`, `.github/` before deletion): `bin/gh-hud.js`,
  `test-fixes.js`, `test-fixes.cjs`, `test-kill.js`, `test-api.js`, `test-github.js`,
  `test-docker.js`, `test-docker-format.js`, `debug-blessed.js`, `FIXES_APPLIED.md`.
- `bin/` is now empty; the `.npmignore` `bin/` line stays (harmless, per instructions).
- Renamed `example.gh-hud.json` → `example.ops-hud.json`, updated its `repositories` entry
  to `mquinnv/ops-hud`, and added a `buildkite: { org, pipelines }` block.
- `.gitignore`: `.gh-hud.json` is a local per-checkout config override (same class as
  `.env.local`), so added `.ops-hud.json` above it — both the new and old name are now
  ignored, since an upgrading user may still have the old file in their checkout (Ruling 5).
- `TODO.md`: title `# gh-hud TODO List` → `# ops-hud TODO List`.
- `README.md`: full rewrite (see below).

### README rewrite
Retitled to `ops-hud`; every `gh-hud` command/install line updated to `ops-hud`; removed the
stale `version-1.1.0` badge outright rather than hardcode a value that will drift again
(the brief said "fixed or removed"; a static badge tied to package.json's actual version
would need manual upkeep on every release, and a dynamic npm badge would 404 until the
owner publishes — removing was the only option that documents nothing false). Added:
- A Buildkite setup section: `$BUILDKITE_API_TOKEN` takes precedence over `buildkite.token`
  (with the plaintext-in-config caveat), org auto-detection when the token reaches exactly
  one org (`--bk-org`/`buildkite.org` otherwise), required scopes (`read_builds`,
  `read_pipelines`, plus `write_builds` for cancel/rebuild and `read_build_logs` for logs —
  verified against `src/providers/buildkite.ts`'s `TokenRejected` messages and doc comments).
  Explicitly noted cancel/rebuild use `PUT` per the REST reference but are **not verified
  against a live API** (per `src/providers/buildkite.ts` comments) — did not claim this is
  tested.
- How a checkout maps to pipelines: via the pipeline's `repository` field (a git remote),
  parsed and matched against watched repos (`indexPipelinesByRepo` in
  `src/providers/buildkite-map.ts`), with an explicit `buildkite.pipelines`/`--pipeline`
  list overriding that derivation (confirmed in `src/providers/buildkite.ts`'s `fetchRuns`).
  With no repos scoped and no explicit pipeline list, it's org-wide.
- New flags table: `--bk-org`, `--pipeline`, `--no-buildkite`, `--no-github`, with
  `--no-github` documented as hiding GitHub Actions runs only — PRs stay governed by
  `--show-prs` (verified in `src/app.ts`'s `buildProviders`/`initialize`, and covered by the
  "Ruling 26" test in `src/app.test.ts`).
- A "Diagnostics" section describing the empty-grid diagnostic panel
  (`src/dashboard.ts` ~line 1538) and the status-bar `⚠` indicator for error-level
  diagnostics added in commit `73b0e35` (verified via `git show` and
  `errorDiagnosticsSegment()` in `src/dashboard.ts`).
- "Upgrading from gh-hud" section: binary rename, config/prefs fallback behavior, both
  described only as implemented (no auto-migration claimed).
- `example.ops-hud.json` referenced from the Configuration section.

## Remaining `gh-hud` hits and their exemption

Full sweep after all changes:
```
grep -rniI --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  -e 'gh-hud' -e 'gh_hud' -e 'ghhud' .
```

| Location | Exemption |
|---|---|
| `.gitignore:8` `.gh-hud.json` | Ruling 5 — kept alongside the new `.ops-hud.json` line so an upgrading user's old local config file is still ignored. |
| `README.md` "Upgrading from gh-hud" section (multiple lines) | Ruling 3 — README lines deliberately documenting the rename. |
| `bun.lock:6` `"name": "gh-hud"` | Stale before `bun install` regenerated it; **after** running `bun install` (see Gates) the lockfile reads `"name": "ops-hud"`. No longer present once the gate ran. |
| `.git:1` (worktree gitdir pointer) | Not repo content or a tracked file — this worktree's `.git` file is a one-line pointer (`gitdir: /Users/michael/Projects/gh-hud/.git/worktrees/...`) generated by `git worktree add`. It matches only because the main checkout's on-disk directory is itself named `gh-hud`. Renaming that local directory is a filesystem/container concern outside this task's scope (the analogous GitHub-repo rename is explicitly a post-implementation, owner-only step per the brief) and is git-internal plumbing, not shipped or committed content. |
| `docs/superpowers/specs/2026-09-17-ops-hud-buildkite-design.md` (multiple lines) | Ruling 3 — everything under `docs/superpowers/` is the historical spec, left untouched. |
| `docs/superpowers/plans/2026-09-17-ops-hud-buildkite.md` (multiple lines) | Ruling 3 — everything under `docs/superpowers/` is the historical plan, left untouched. |
| `src/dashboard.ts:2897` `legacyPrefsPath = ... ".gh-hud-prefs.json"` | Ruling 3 — intentional legacy-fallback path for prefs, added by this task per the brief/spec §5. |
| `src/config.ts:80,82-84` legacy `gh-hud` config paths + comment | Ruling 3 — intentional legacy-fallback config paths, added by this task per the brief/spec §5. |
| `src/config.test.ts:103,105,107,115` (`"config path migration"` describe block) | Companion regression test for the exempted `config.ts` fallback directly above — it must use the literal legacy filename to test that fallback; not itself a straggler. |
| `src/fixtures/github-runs.json`, `src/fixtures/github-jobs.json` | Ruling 3 — explicitly named exemptions; recorded real API responses for `mquinnv/gh-hud`, left untouched (test assertions in `src/providers/github.test.ts` no longer reference the old repo name directly — they use `"acme/widgets"` as the scope input — but they still parse these fixtures' content for their own field values, which is fine since the fixtures are exempt from renaming). |

No unexplained hit remains.

## Gate outputs

**`bun install`** — regenerated `bun.lock` from scratch (deleted and reinstalled to force
the rewrite, since a plain `bun install` over the existing lockfile did not update the
`name` field). Confirmed: `bun.lock` now has `"name": "ops-hud"`.

**`bun run build`** — `$ bun run tsc` — no output, exit 0.

**`bun test`**:
```
bun test v1.3.11 (af24e281)

 185 pass
 0 fail
 380 expect() calls
Ran 185 tests across 10 files. [1.55s]
```
(183 baseline + 2 new config-path-migration tests = 185.)

**`bun biome check .`** — exit 0:
```
Checked 28 files in 31ms. No fixes applied.
Found 2 infos.
```
The 2 infos are unrelated pre-existing schema-version notices from the `biome.json`
`$schema` pin (2.2.4) vs. the CLI resolved by the lockfile regen (2.5.14, within the
`^2.2.3` devDependency range) — informational only, not errors, and not part of this
task's scope.

**`bun run lint`** — ran clean, same 2 infos, exit 0, no fixes needed.

**ESC check**:
```
bun test </dev/null >/tmp/opshud-t9.txt 2>&1
LC_ALL=C grep -c "$(printf '\033')" /tmp/opshud-t9.txt
```
→ prints `0`.

**Symlink `--help` check** (`node` launching through a symlink, as npm's `.bin` shim does):
```
$ ln -s <worktree>/dist/index.js /tmp/ops-hud
$ node /tmp/ops-hud --help
Usage: ops-hud [options] [command] [path]

CI and ops dashboard for the terminal — GitHub Actions and Buildkite
...
Options:
  ...
  --bk-org <org>                Buildkite organization slug
  --pipeline <slugs...>         Buildkite pipeline slugs to watch
  --no-buildkite                Disable the Buildkite provider
  --no-github                   Disable the GitHub provider
  -h, --help                    display help for command

Commands:
  watch [options] [path]        Watch CI runs
```
Usage line says `ops-hud`; all four Buildkite/GitHub flags present.

**`npm pack --dry-run`** file list (59 files total, 90.3 kB packed):
- `LICENSE`
- `README.md`
- `dist/**` (all `.js`, `.d.ts`, and `.map` files — `app`, `cli`, `config`, `dashboard`,
  `docker-utils`, `index`, `providers/{buildkite-map,buildkite,github-map,github,types}`,
  `run-wording`, `status`, `types`)
- `package.json`

No deleted scratch file appears; `bin/` is absent (never shipped, per `.npmignore`).
Tarball name: `ops-hud-2.0.0.tgz` (not written to disk — `--dry-run` only prints the plan;
confirmed absent from the working tree afterward, and `git status` showed no stray file).

## Commit

One commit, staged as `git add -A`, with the brief's exact `feat!:` message plus the
required `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.
