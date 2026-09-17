# ops-hud: rename from gh-hud and add Buildkite support

Date: 2026-09-17
Status: approved, ready for implementation planning

## Summary

Rename `gh-hud` to `ops-hud` and teach it to monitor Buildkite builds alongside
GitHub Actions runs in the same grid.

Today the tool is GitHub-only: `GitHubService` is called directly from `App`,
and `WorkflowRun`/`WorkflowJob` in `src/types.ts` are literal GitHub Actions API
shapes. Supporting a second CI provider means introducing a provider-neutral
domain model and a `CiProvider` interface behind it. The rename is mechanical
but breaking (binary name, config filename), so it ships as 2.0.0.

## Motivation

AmeriGlide's Buildkite org (`ameriglide`, created 2026-09-16) holds 40+
`site-content-*` pipelines, each mapped 1:1 onto a `github.com/inetalliance/*`
repository. These appear to be the successor to the `site-content-cd`
GitHub Actions dispatch path. During and after that transition, a single repo's
CI state lives in two systems at once, and there is no one place to watch it.

The name `gh-hud` also no longer describes the tool: it already shows Docker
Compose services and pull requests, and will now show a second CI provider.

## Goals

- One grid showing GitHub Actions runs and Buildkite builds together.
- `ops-hud ~/Projects/usm` resolves the checkout to *both* its Actions runs and
  its Buildkite pipelines with no extra configuration.
- Full interactive parity: cancel, rerun/rebuild, logs, open-in-browser, and
  dismiss work identically regardless of which provider a card came from.
- Existing gh-hud users keep their config and saved preferences across the
  rename.
- Installable from npm and fully functional with no Buildkite account.

## Non-goals

- Docker BuildKit / `docker buildx` build monitoring. (Considered and
  explicitly ruled out: "buildkit" in the original request meant Buildkite.)
- Multi-org Buildkite. All pipelines are expected to live in one org.
- Breaking up `dashboard.ts` beyond the one narrow extraction described below.
- Testing the network layer or blessed rendering; neither is tested today.

## Approach

Three options were considered.

**A. Neutral domain model behind a `CiProvider` interface.** *(chosen)*
Providers map their native payloads into a shared `Run`/`Job` model; the
dashboard only ever sees the neutral type.

**B. Translate Buildkite into the existing GitHub shape.** Rejected. It is
lossy and it lies: Buildkite's `blocked` state (a build paused on a manual
unblock step) has no GitHub equivalent, and a blocked deploy waiting on a human
is precisely what an ops HUD exists to surface. It would also require hashing
build UUIDs into the numeric `id` fields the current code expects.

**C. A separate Buildkite panel**, like the Docker header. Rejected: it defeats
the purpose (you want `inetalliance/usm`'s Actions run and its
`site-content-usm` build adjacent) and duplicates the grid layout and
navigation code.

Note that the ID type change is forced under any option: Buildkite build IDs
are UUIDs, while `App` currently keys `watchedWorkflows: Set<number>` and
`completedWorkflows: Map<number, WorkflowRun>`. These become string-keyed.

## Design

### 1. The neutral model

`src/types.ts`. `WorkflowRun`/`WorkflowJob` are replaced by `Run`/`Job`.

```ts
type Provider = "github" | "buildkite"

type RunStatus =
  | "queued" | "running" | "blocked"          // in flight
  | "passed" | "failed" | "canceled"
  | "skipped" | "timed_out" | "action_required"

interface Run {
  provider: Provider
  key: string          // `${provider}:${repo.fullName}:${id}` — stable grid identity
  id: string           // GH databaseId as string | BK build UUID
  number: number       // run_number | build number
  title: string        // display_title | build message, first line
  pipeline: string     // workflowName | pipeline.name — for display
  pipelineSlug?: string // Buildkite only: required to address the write endpoints
  branch: string
  sha: string
  status: RunStatus
  isFailing: boolean   // running, but a job has already failed
  repo: { owner: string; name: string; fullName: string }
  actor?: string
  commitMessage?: string
  webUrl: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

interface Job {
  id: string
  runKey: string
  name: string
  status: RunStatus
  startedAt?: string
  finishedAt?: string
  agent?: string                                  // runner_name | agent.name
  webUrl?: string
  steps?: Step[]                                  // GitHub only
  command?: string                                // Buildkite only
  type?: "script" | "manual" | "trigger" | "waiter"  // Buildkite only
}
```

`Step` is today's `WorkflowStep`, renamed and with its `(status, conclusion)`
pair collapsed to a single `RunStatus` like everything else. `Repository`,
`PullRequest`, and the Docker types are unchanged.

`Scope` is what the existing path/`-r`/`--org` resolution already produces,
widened to carry the Buildkite selection:

```ts
interface Scope {
  repositories: string[]        // "owner/repo"
  organizations: string[]       // GitHub orgs
  buildkite?: { org: string; pipelines: string[] }  // resolved from repositories
}
```

The central simplification is collapsing GitHub's `(status, conclusion)` pair
into a single `status`. The dashboard currently threads both through
`getStatusIcon(status, conclusion)` and `getStatusColor(status, conclusion)` at
roughly 15 call sites; Buildkite has no such pair.

Status mapping:

| GitHub | neutral |
| --- | --- |
| `queued`, `waiting` | `queued` |
| `in_progress` | `running` |
| `completed` + `success` | `passed` |
| `completed` + `failure` | `failed` |
| `completed` + `cancelled` | `canceled` |
| `completed` + `skipped` | `skipped` |
| `completed` + `timed_out` | `timed_out` |
| `completed` + `action_required` | `action_required` |
| `completed` + `neutral` | `skipped` |

| Buildkite | neutral |
| --- | --- |
| `creating`, `scheduled` | `queued` |
| `running` | `running` |
| `failing` | `running`, with `isFailing: true` |
| `blocked` | `blocked` |
| `passed` | `passed` |
| `failed` | `failed` |
| `canceling`, `canceled` | `canceled` |
| `skipped`, `not_run` | `skipped` |

`isFailing` is the one new concept and it applies uniformly: Buildkite gives it
directly as the `failing` state; for GitHub it is derived from the already
fetched jobs. A run that is still going but already doomed renders differently
from a healthy one.

A Buildkite job with `type: "manual"` and status `blocked` renders as "waiting
for unblock". Buildkite jobs have no steps — a Buildkite job *is* a step — so
the card renders `steps` when present and falls back to `command`.

### 2. Provider interface and fetch layer

```ts
interface CiProvider {
  readonly name: Provider
  fetchRuns(scope: Scope): Promise<{ runs: Run[]; jobs?: Map<string, Job[]> }>
  fetchJobs(run: Run): Promise<Job[]>
  cancel(run: Run): Promise<void>
  rerun(run: Run): Promise<void>
  logs(run: Run, job?: Job): Promise<string>
}
```

The two providers have different fetch economics and the interface admits that
rather than papering over it.

**GitHub** is N+1: one call per repo for runs, then one call per *visible* run
for jobs (as today — `App` already fetches jobs lazily for displayed cards).
It returns `jobs: undefined`.

**Buildkite** is not. `GET /v2/organizations/{org}/builds?per_page=N` returns
every build in the org **with its jobs embedded** (jobs are included unless
`exclude_jobs=true`). One request covers all 40+ pipelines. `fetchRuns`
therefore returns the jobs alongside the runs, and `App` skips the per-run job
fetch when they are already present. Forcing Buildkite into the GitHub N+1
shape would turn one request into forty.

Transports differ, and that is fine: GitHub shells out to `gh` (which owns
auth); Buildkite uses `fetch` with `Authorization: Bearer $TOKEN`. The existing
5-second response cache in `GitHubService` moves up into a small shared wrapper
so both providers get it.

Writes:

| action | GitHub | Buildkite |
| --- | --- | --- |
| cancel | `gh run cancel {id} -R {repo}` | `POST /v2/organizations/{org}/pipelines/{slug}/builds/{number}/cancel` |
| rerun | `gh run rerun {id} -R {repo}` | `POST .../builds/{number}/rebuild` |
| logs | `gh run view {id} -R {repo} --log` | `GET` the job's `log_url` |

Buildkite writes need the `write_builds` scope and logs need `read_build_logs`.

### 3. Migrating the GitHub run fetch to `gh api`

The run fetch moves from `gh run list --json ...` to
`gh api repos/{owner}/{repo}/actions/runs?per_page=N`.

This is not a stylistic preference. `gh run list --json` accepts only 16 fields
and exposes **no commit message, author, or actor** — `src/github.ts:97` sets
`headCommit: undefined` with the comment *"gh run list doesn't provide commit
info"*, populating a field `types.ts` declares. The raw API provides
`head_commit.message`, `head_commit.author.name`, `actor.login`,
`run_started_at`, and `run_attempt`. Buildkite's build payload supplies
`message` and `creator` for free, so for both providers to render the same card,
GitHub has to supply them too.

**The PR fetch stays on `gh pr list --json`.** `statusCheckRollup`,
`reviewDecision`, and `mergeable` are GraphQL-only concepts that `gh pr list`
assembles in a single call; via REST they would cost two or more extra requests
per PR for no gain. `getWorkflowJobs` already uses `gh api` and is unchanged in
approach.

### 4. Scoping and configuration

Every Buildkite pipeline carries its repository, e.g.
`git@github.com:inetalliance/usm.git`. `parseGitHubRemote()` in `src/config.ts`
already parses that exact form and strips `.git`. So:

1. On startup, fetch `/v2/organizations/{org}/pipelines` once.
2. Build an index `owner/repo -> pipeline slugs` by running each pipeline's
   `repository` field through the existing parser.
3. `ops-hud ~/Projects/usm` resolves cwd -> `inetalliance/usm` -> both its
   Actions runs and its `site-content-usm` builds.

Scope resolution stays a single concept; it fans out to two providers.

The Buildkite org is a single string. If it is not configured, ops-hud calls
`GET /v2/organizations` once: exactly one org, use it silently; zero or several,
fail with a message listing the slugs. Note that the pipelines live under the
`ameriglide` Buildkite org while the repos are `inetalliance/*` on GitHub — the
index keys off the repository URL, not the org name, so the mismatch is handled,
but the Buildkite org cannot be inferred from a GitHub remote.

```jsonc
// .ops-hud.json
{
  "repositories": ["inetalliance/usm"],
  "buildkite": {
    "token": "bkua_...",        // or $BUILDKITE_API_TOKEN, which takes precedence
    "org": "ameriglide",        // optional; auto-detected when the token reaches exactly one
    "pipelines": []             // optional explicit list; empty = derive from repositories
  }
}
```

Token resolution: `$BUILDKITE_API_TOKEN` first, then `buildkite.token` from
config. **If no token is found, the Buildkite provider is disabled silently**
and the dashboard behaves exactly as it does today. This keeps ops-hud
installable and useful for anyone without a Buildkite account, and means the
rename alone never breaks an existing user.

New flags: `--bk-org`, `--pipeline`, `--no-buildkite`, `--no-github`.

### 5. The rename

54 occurrences across 15 files. Three need care:

- **Config paths** (`src/config.ts:73-78`) become `.ops-hud.json`,
  `~/.ops-hud.json`, `~/.config/ops-hud/config.json`, with the three `gh-hud`
  paths **retained as fallbacks after them**. Existing configs keep working;
  new ones take precedence.
- **Prefs file** (`src/dashboard.ts:2889,2943`) `~/.gh-hud-prefs.json` becomes
  `~/.ops-hud-prefs.json`, reading the old path when the new one is absent and
  then writing the new one. Saved layout survives the upgrade.
- **`bin/gh-hud.js` is deleted, not renamed.** `.npmignore` excludes `bin/` and
  `package.json`'s `bin` points at `./dist/index.js`, so that shim has never
  shipped. Renaming it would preserve dead weight.

Also: `package.json` name / bin / description / keywords / repository / bugs /
homepage / the `gh-hud` script entry; `src/index.ts` `program.name()` and
description; the dashboard's `"GitHub Workflow Monitor"` title
(`dashboard.ts:73`), help header (`:1029`) and `"GitHub HUD started"` log
(`:1280`) become "Ops HUD"; `example.gh-hud.json` -> `example.ops-hud.json`;
`.gitignore`; `README.md`; `TODO.md`; and the two test files.

Release: **2.0.0**. Rename the GitHub repo `mquinnv/gh-hud` -> `mquinnv/ops-hud`
(GitHub redirects the old URL), publish `ops-hud` to npm, then
`npm deprecate gh-hud` pointing at the new package.

### 6. Incidental cleanup

Eight unreferenced scratch files at the repo root are deleted:
`test-fixes.js`, `test-fixes.cjs`, `test-kill.js`, `test-api.js`,
`test-github.js`, `test-docker.js`, `test-docker-format.js`,
`debug-blessed.js`. Nothing imports them, `bun test` does not collect them (it
matches `*.test.ts`), and five contain `gh-hud` strings that would otherwise
need renaming. Deleting is cheaper than renaming dead code.

`FIXES_APPLIED.md` appears to be a stale scratch note in the same category.
**Confirm with Michael before removing it.**

This is in scope only because it sits in the rename's blast radius. No other
refactoring is proposed.

## Testing

The suite today is 115 lines across `config.test.ts` and `docker-utils.test.ts`.
Everything this design adds that is worth testing is deliberately a pure
function:

- **Status mapping** — table-driven over every GitHub `(status, conclusion)`
  pair and every Buildkite state, including `blocked` and `failing`.
- **Buildkite payload -> `Run`/`Job`**, from a fixture captured off the real API.
- **`gh api` runs payload -> `Run`/`Job`**, from a real fixture. This is where
  `commitMessage` and `actor` finally get populated.
- **Pipeline `repository` -> `owner/repo` index**, reusing `parseGitHubRemote`.
- **Config precedence** — env token beats config token; legacy config and prefs
  paths resolve; **no token means the provider is disabled and nothing crashes**.

To make the status tests possible, the icon and color logic moves out of
`dashboard.ts` into a new `src/status.ts`. That is a narrow extraction in direct
service of this work.

Network calls and blessed rendering stay untested, as they are today.

## Risks

- **`dashboard.ts` is 3001 lines** and every card-rendering path touches the
  renamed model. The `(status, conclusion)` -> `status` collapse is the largest
  single source of churn. Mitigated by extracting `src/status.ts` first and
  changing call sites mechanically.
- **Buildkite token in plaintext config.** Documented as supported but
  secondary to `$BUILDKITE_API_TOKEN`. The config path must be mentioned in the
  README with that caveat.
- **Rate limits.** Buildkite's org-wide builds call is one request per refresh,
  so the default 5s interval is fine; GitHub's existing N+1 is unchanged.
- **Buildkite pagination.** 40+ pipelines exceed the default page size. The
  pipeline index fetch must follow `Link: rel="next"`.
