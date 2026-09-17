# ops-hud: Rename and Buildkite Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `gh-hud` to `ops-hud` and let it monitor Buildkite builds alongside GitHub Actions runs in one grid, behind a provider-neutral model.

**Architecture:** A neutral `Run`/`Job` domain model replaces the GitHub-shaped `WorkflowRun`/`WorkflowJob`. Two implementations of a `CiProvider` interface (`GitHubProvider`, `BuildkiteProvider`) map their native payloads into it; `App` fans out to both and merges; `Dashboard` only ever sees neutral types. GitHub keeps shelling out to `gh`; Buildkite uses `fetch` with a bearer token.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Bun (runtime, test runner, package manager), Biome (lint/format), blessed (TUI), execa (subprocess), commander (CLI), date-fns.

**Spec:** `docs/superpowers/specs/2026-09-17-ops-hud-buildkite-design.md`

## Global Constraints

- **Package name:** `ops-hud`. Binary `ops-hud`. Version **2.0.0**.
- **Node engine floor:** `>=18.0.0` (unchanged). `fetch` is global from Node 18 — do not add a HTTP dependency.
- **Module system:** ESM. All relative imports end in `.js` even though sources are `.ts` (e.g. `import { X } from "./status.js"`). This is existing convention; matching it is mandatory or `tsc` output will not resolve.
- **Test runner:** `bun test`. Tests live beside sources as `src/<name>.test.ts` and import from `bun:test`.
- **Lint/format:** `bun biome check .` must pass. Run `bun run lint` (which is `biome check --write .`) before committing.
- **Buildkite API base:** `https://api.buildkite.com/v2`. Auth header `Authorization: Bearer <token>`.
- **Never send `exclude_jobs=true`** on Buildkite build requests — jobs are needed and are included by default.
- **Buildkite pagination:** follow the `Link: <...>; rel="next"` response header. The `ameriglide` org has 40+ pipelines (3 pages at the default page size).
- **No new runtime dependencies.** devDependencies unchanged.
- **Config file precedence:** `$BUILDKITE_API_TOKEN` beats `buildkite.token` in config, always.
- **Silent vs loud:** a *missing* Buildkite token is a silent skip; a token that is *present and fails* must be reported loudly.
- Do not assume the `site-content-` pipeline prefix anywhere.

---

## File Structure

**New:**
- `src/status.ts` — the `RunStatus` enum, provider→neutral status mappers, `isTerminal`, icons, colors. Pure; no imports from the rest of the app.
- `src/status.test.ts`
- `src/providers/types.ts` — `CiProvider` interface, `Scope`, `ProviderDiagnostic`.
- `src/providers/github.ts` — `GitHubProvider`. Absorbs today's `src/github.ts`.
- `src/providers/github-map.ts` — pure `gh api` payload → `Run`/`Job`.
- `src/providers/github-map.test.ts`
- `src/providers/buildkite.ts` — `BuildkiteProvider` (HTTP, pagination, token/org resolution).
- `src/providers/buildkite-map.ts` — pure Buildkite payload → `Run`/`Job`.
- `src/providers/buildkite-map.test.ts`
- `src/providers/buildkite-config.test.ts` — token/org resolution and diagnostics.
- `src/fixtures/github-runs.json`, `src/fixtures/github-jobs.json`, `src/fixtures/buildkite-builds.json`, `src/fixtures/buildkite-pipelines.json` — captured real payloads.

**Modified:**
- `src/types.ts` — `Run`, `Job`, `Step` replace `WorkflowRun`, `WorkflowJob`, `WorkflowStep`. `Config` gains `buildkite`.
- `src/config.ts` — new config paths + legacy fallbacks; Buildkite config block.
- `src/app.ts` — multi-provider fan-out; string-keyed trackers.
- `src/dashboard.ts` — neutral model; status logic removed to `src/status.ts`; prefs path.
- `src/index.ts` — program name, new flags.
- `package.json`, `README.md`, `TODO.md`, `.gitignore`, `example.gh-hud.json`→`example.ops-hud.json`.

**Deleted:** `bin/gh-hud.js`, `test-fixes.js`, `test-fixes.cjs`, `test-kill.js`, `test-api.js`, `test-github.js`, `test-docker.js`, `test-docker-format.js`, `debug-blessed.js`, `FIXES_APPLIED.md`.

---

### Task 1: Neutral status model

Pure functions, no dependencies. Nothing consumes this yet — it is the foundation the rest builds on.

**Files:**
- Create: `src/status.ts`
- Test: `src/status.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type RunStatus`, `fromGitHub(status: string, conclusion?: string): RunStatus`, `fromBuildkite(state: string): RunStatus`, `isTerminal(s: RunStatus): boolean`, `isActive(s: RunStatus): boolean`, `statusIcon(s: RunStatus, isFailing?: boolean): string`, `statusColor(s: RunStatus, isFailing?: boolean): string`.

- [ ] **Step 1: Write the failing test**

Create `src/status.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import {
  fromBuildkite,
  fromGitHub,
  isActive,
  isTerminal,
  statusColor,
  statusIcon,
} from "./status.js"

describe("fromGitHub", () => {
  test("maps in-flight statuses", () => {
    expect(fromGitHub("queued")).toBe("queued")
    expect(fromGitHub("waiting")).toBe("queued")
    expect(fromGitHub("in_progress")).toBe("running")
  })

  test("maps completed runs by conclusion", () => {
    expect(fromGitHub("completed", "success")).toBe("passed")
    expect(fromGitHub("completed", "failure")).toBe("failed")
    expect(fromGitHub("completed", "cancelled")).toBe("canceled")
    expect(fromGitHub("completed", "skipped")).toBe("skipped")
    expect(fromGitHub("completed", "timed_out")).toBe("timed_out")
    expect(fromGitHub("completed", "action_required")).toBe("action_required")
    expect(fromGitHub("completed", "neutral")).toBe("skipped")
  })

  // A completed run with no conclusion is a GitHub race, not a bug in us:
  // the run finished between listing and reading. Treat it as still running
  // so the next refresh corrects it, rather than showing a false verdict.
  test("treats a completed run with no conclusion as running", () => {
    expect(fromGitHub("completed")).toBe("running")
  })

  test("falls back to running for unknown statuses", () => {
    expect(fromGitHub("something_new")).toBe("running")
  })
})

describe("fromBuildkite", () => {
  test("maps every documented build state", () => {
    expect(fromBuildkite("creating")).toBe("queued")
    expect(fromBuildkite("scheduled")).toBe("queued")
    expect(fromBuildkite("running")).toBe("running")
    expect(fromBuildkite("failing")).toBe("running")
    expect(fromBuildkite("blocked")).toBe("blocked")
    expect(fromBuildkite("passed")).toBe("passed")
    expect(fromBuildkite("failed")).toBe("failed")
    expect(fromBuildkite("canceling")).toBe("canceled")
    expect(fromBuildkite("canceled")).toBe("canceled")
    expect(fromBuildkite("skipped")).toBe("skipped")
    expect(fromBuildkite("not_run")).toBe("skipped")
  })

  // Buildkite job states include values build states don't, and new ones
  // appear over time. An unknown state must never crash the grid.
  test("falls back to running for unknown states", () => {
    expect(fromBuildkite("assigned")).toBe("running")
  })
})

describe("isTerminal / isActive", () => {
  test("in-flight statuses are active", () => {
    for (const s of ["queued", "running", "blocked"] as const) {
      expect(isActive(s)).toBe(true)
      expect(isTerminal(s)).toBe(false)
    }
  })

  test("finished statuses are terminal", () => {
    for (const s of ["passed", "failed", "canceled", "skipped", "timed_out"] as const) {
      expect(isTerminal(s)).toBe(true)
      expect(isActive(s)).toBe(false)
    }
  })

  // action_required is a real GitHub terminal state (a run stopped awaiting
  // manual approval). It is terminal for the run but needs a human, so it
  // must not be swept up by "dismiss all completed".
  test("action_required is terminal", () => {
    expect(isTerminal("action_required")).toBe(true)
  })
})

describe("icons and colors", () => {
  test("distinguishes a doomed running build from a healthy one", () => {
    expect(statusIcon("running", false)).not.toBe(statusIcon("running", true))
    expect(statusColor("running", false)).not.toBe(statusColor("running", true))
  })

  test("blocked has its own icon and colour", () => {
    expect(statusIcon("blocked")).toBe("⏸")
    expect(statusColor("blocked")).toBe("cyan")
  })

  test("every status yields a non-empty icon and colour", () => {
    const all = [
      "queued", "running", "blocked", "passed", "failed",
      "canceled", "skipped", "timed_out", "action_required",
    ] as const
    for (const s of all) {
      expect(statusIcon(s).length).toBeGreaterThan(0)
      expect(statusColor(s).length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/status.test.ts`
Expected: FAIL — `Cannot find module './status.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/status.ts`:

```ts
// The provider-neutral status model. GitHub reports a (status, conclusion)
// pair; Buildkite reports a single state with values GitHub has no name for.
// Both collapse to this one enum so the dashboard never branches on provider.

export type RunStatus =
  | "queued"
  | "running"
  | "blocked"
  | "passed"
  | "failed"
  | "canceled"
  | "skipped"
  | "timed_out"
  | "action_required"

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "passed",
  "failed",
  "canceled",
  "skipped",
  "timed_out",
  "action_required",
])

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status)
}

export function isActive(status: RunStatus): boolean {
  return !TERMINAL.has(status)
}

export function fromGitHub(status: string, conclusion?: string | null): RunStatus {
  if (status === "completed") {
    switch (conclusion) {
      case "success":
        return "passed"
      case "failure":
        return "failed"
      case "cancelled":
        return "canceled"
      case "skipped":
      case "neutral":
        return "skipped"
      case "timed_out":
        return "timed_out"
      case "action_required":
        return "action_required"
      default:
        // Completed with no conclusion yet: the run finished between the
        // list call and this read. Keep it in flight; the next refresh
        // resolves it rather than us inventing a verdict.
        return "running"
    }
  }

  switch (status) {
    case "queued":
    case "waiting":
    case "pending":
      return "queued"
    case "in_progress":
      return "running"
    default:
      return "running"
  }
}

export function fromBuildkite(state: string): RunStatus {
  switch (state) {
    case "creating":
    case "scheduled":
      return "queued"
    case "running":
    // A failing build is still running — a job has failed but the build has
    // not stopped. Callers surface that through Run.isFailing, not here.
    case "failing":
      return "running"
    case "blocked":
      return "blocked"
    case "passed":
      return "passed"
    case "failed":
    case "broken":
      return "failed"
    case "canceling":
    case "canceled":
      return "canceled"
    case "skipped":
    case "not_run":
      return "skipped"
    case "timing_out":
    case "timed_out":
      return "timed_out"
    default:
      return "running"
  }
}

export function statusIcon(status: RunStatus, isFailing = false): string {
  if (status === "running") return isFailing ? "◉" : "●"
  switch (status) {
    case "queued":
      return "○"
    case "blocked":
      return "⏸"
    case "passed":
      return "✓"
    case "failed":
      return "✗"
    case "canceled":
      return "⊘"
    case "skipped":
      return "⊜"
    case "timed_out":
      return "⏱"
    case "action_required":
      return "⚠"
  }
}

export function statusColor(status: RunStatus, isFailing = false): string {
  if (status === "running") return isFailing ? "red" : "yellow"
  switch (status) {
    case "queued":
      return "#888888"
    case "blocked":
      return "cyan"
    case "passed":
      return "green"
    case "failed":
      return "red"
    case "canceled":
    case "skipped":
      return "#888888"
    case "timed_out":
      return "magenta"
    case "action_required":
      return "yellow"
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/status.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint
git add src/status.ts src/status.test.ts
git commit -m "feat: add provider-neutral run status model"
```

---

### Task 2: Neutral domain types

Replace the GitHub-shaped types with neutral ones. This task only edits `src/types.ts`; the rest of the codebase still references the old names and **will not compile until Task 4**. That is expected and acceptable — Task 3 and Task 4 close it. Do not attempt to keep `tsc` green at the end of this task.

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `RunStatus` from `src/status.ts` (Task 1).
- Produces: `Provider`, `Run`, `Job`, `Step`, `Repository` (unchanged), `Config` (extended), `DashboardState` (updated).

- [ ] **Step 1: Replace the run/job/step types**

In `src/types.ts`, delete the `WorkflowRun`, `WorkflowJob`, and `WorkflowStep` interfaces and add, at the top of the file:

```ts
import type { RunStatus } from "./status.js"

export type Provider = "github" | "buildkite"

export interface Step {
  name: string
  status: RunStatus
  number: number
  startedAt?: string
  finishedAt?: string
}

export interface Job {
  id: string
  runKey: string
  name: string
  status: RunStatus
  startedAt?: string
  finishedAt?: string
  agent?: string
  webUrl?: string
  steps?: Step[]
  command?: string
  type?: "script" | "manual" | "trigger" | "waiter"
}

export interface Run {
  provider: Provider
  /** Stable grid identity: `${provider}:${repo.fullName}:${id}`. */
  key: string
  /** Native id as a string. GitHub: databaseId. Buildkite: build UUID. */
  id: string
  /** run_number (GitHub) or build number (Buildkite). */
  number: number
  /** First line of the commit message, or GitHub's display_title. */
  title: string
  /** Workflow name (GitHub) or pipeline name (Buildkite), for display. */
  pipeline: string
  /** Buildkite only: required to address the build write endpoints. */
  pipelineSlug?: string
  branch: string
  sha: string
  status: RunStatus
  /** Running, but a job has already failed. */
  isFailing: boolean
  repo: { owner: string; name: string; fullName: string }
  actor?: string
  commitMessage?: string
  webUrl: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}
```

- [ ] **Step 2: Extend `Config` with the Buildkite block**

In the same file, replace the `Config` interface with:

```ts
export interface BuildkiteConfig {
  /** Prefer $BUILDKITE_API_TOKEN, which always takes precedence over this. */
  token?: string
  /** Auto-detected when the token reaches exactly one organization. */
  org?: string
  /** Explicit pipeline slugs. Empty means: derive from `repositories`. */
  pipelines?: string[]
}

export interface Config {
  repositories?: string[]
  organizations?: string[]
  refreshInterval?: number
  maxWorkflows?: number
  filterStatus?: string[]
  showCompletedFor?: number // minutes to show completed workflows
  buildkite?: BuildkiteConfig
}
```

- [ ] **Step 3: Update `DashboardState`**

```ts
export interface DashboardState {
  runs: Map<string, Run>
  jobs: Map<string, Job[]>
  pullRequests?: PullRequest[]
  dockerServices?: DockerServiceStatus[]
  lastUpdate: Date
  error?: string
}
```

Leave `Repository`, `PullRequest`, and every `Docker*` type exactly as they are.

- [ ] **Step 4: Verify the file itself is coherent**

Run: `bun biome check src/types.ts`
Expected: PASS. (`bun run build` will still fail — the rest of the app has not been migrated. That is expected at this point in the plan.)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat: replace GitHub-shaped run types with a neutral model

The tree does not compile at this commit; app.ts and dashboard.ts are
migrated in the following two tasks."
```

---

### Task 3: GitHub payload mapping

Pure mapping from `gh api` JSON to the neutral model, tested against a captured real payload. This is where `commitMessage` and `actor` — which `gh run list --json` cannot supply — finally get populated.

**Files:**
- Create: `src/providers/github-map.ts`, `src/providers/github-map.test.ts`
- Create: `src/fixtures/github-runs.json`, `src/fixtures/github-jobs.json`

**Interfaces:**
- Consumes: `Run`, `Job`, `Step` from `src/types.ts`; `fromGitHub`, `isTerminal` from `src/status.ts`.
- Produces: `mapGitHubRun(raw: GitHubRunPayload): Run`, `mapGitHubJob(raw: GitHubJobPayload, runKey: string): Job`, `applyIsFailing(run: Run, jobs: Job[]): Run`, and the two payload interfaces.

- [ ] **Step 1: Capture real fixtures**

Run these and save the output. Any repo with recent runs works; `mquinnv/gh-hud` is the source of truth for the shape.

```bash
mkdir -p src/fixtures
gh api 'repos/mquinnv/gh-hud/actions/runs?per_page=3' > src/fixtures/github-runs.json
RUN_ID=$(gh api 'repos/mquinnv/gh-hud/actions/runs?per_page=1' --jq '.workflow_runs[0].id')
gh api "repos/mquinnv/gh-hud/actions/runs/$RUN_ID/jobs" > src/fixtures/github-jobs.json
```

Confirm the runs fixture actually contains the fields this task exists to capture:

```bash
jq -e '.workflow_runs[0] | .head_commit.message and .actor.login and .run_started_at' src/fixtures/github-runs.json
```

Expected: prints `true`. If it prints `null` or errors, the fixture is wrong — re-capture before continuing.

- [ ] **Step 2: Write the failing test**

Create `src/providers/github-map.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import runsFixture from "../fixtures/github-runs.json"
import jobsFixture from "../fixtures/github-jobs.json"
import { applyIsFailing, mapGitHubJob, mapGitHubRun } from "./github-map.js"
import type { Job } from "../types.js"

const rawRun = runsFixture.workflow_runs[0]
const rawJob = jobsFixture.jobs[0]

describe("mapGitHubRun", () => {
  test("produces a github-provider run with a composite key", () => {
    const run = mapGitHubRun(rawRun)
    expect(run.provider).toBe("github")
    expect(run.id).toBe(String(rawRun.id))
    expect(run.key).toBe(`github:${run.repo.fullName}:${run.id}`)
  })

  test("splits owner and name out of the repository full name", () => {
    const run = mapGitHubRun(rawRun)
    expect(run.repo.fullName).toBe(rawRun.repository.full_name)
    expect(`${run.repo.owner}/${run.repo.name}`).toBe(rawRun.repository.full_name)
  })

  // The whole reason for moving off `gh run list --json`: it cannot supply
  // these, so types.ts declared headCommit and github.ts set it to undefined.
  test("populates the commit message and actor gh run list cannot supply", () => {
    const run = mapGitHubRun(rawRun)
    expect(run.commitMessage).toBe(rawRun.head_commit.message)
    expect(run.actor).toBe(rawRun.actor.login)
  })

  // Commit messages are frequently many paragraphs. The card shows one line.
  test("takes the title from the first line only", () => {
    const multiline = { ...rawRun, head_commit: { ...rawRun.head_commit, message: "first line\n\nbody paragraph" } }
    expect(mapGitHubRun(multiline).title).toBe("first line")
  })

  test("prefers run_started_at over created_at for startedAt", () => {
    const run = mapGitHubRun(rawRun)
    expect(run.startedAt).toBe(rawRun.run_started_at)
  })

  test("defaults isFailing to false", () => {
    expect(mapGitHubRun(rawRun).isFailing).toBe(false)
  })
})

describe("mapGitHubJob", () => {
  test("carries steps and the runner name", () => {
    const job = mapGitHubJob(rawJob, "github:acme/widgets:1")
    expect(job.runKey).toBe("github:acme/widgets:1")
    expect(job.id).toBe(String(rawJob.id))
    expect(job.name).toBe(rawJob.name)
    expect(Array.isArray(job.steps)).toBe(true)
  })

  test("leaves the Buildkite-only fields unset", () => {
    const job = mapGitHubJob(rawJob, "github:acme/widgets:1")
    expect(job.command).toBeUndefined()
    expect(job.type).toBeUndefined()
  })
})

describe("applyIsFailing", () => {
  const base = mapGitHubRun(rawRun)
  const job = (status: Job["status"]): Job => ({
    id: "j", runKey: base.key, name: "n", status,
  })

  test("flags a running run that already has a failed job", () => {
    const run = applyIsFailing({ ...base, status: "running" }, [job("passed"), job("failed")])
    expect(run.isFailing).toBe(true)
  })

  test("leaves a healthy running run alone", () => {
    const run = applyIsFailing({ ...base, status: "running" }, [job("passed"), job("running")])
    expect(run.isFailing).toBe(false)
  })

  // A finished run already says failed in its own status; isFailing is only
  // meaningful while a run is still going.
  test("never flags a finished run", () => {
    const run = applyIsFailing({ ...base, status: "failed" }, [job("failed")])
    expect(run.isFailing).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/providers/github-map.test.ts`
Expected: FAIL — `Cannot find module './github-map.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/providers/github-map.ts`:

```ts
import { fromGitHub, isTerminal } from "../status.js"
import type { Job, Run, Step } from "../types.js"

// Shapes of the `gh api repos/{owner}/{repo}/actions/runs` and
// `.../runs/{id}/jobs` responses — only the fields we actually read.

export interface GitHubRunPayload {
  id: number
  name?: string
  display_title?: string
  head_branch: string
  head_sha: string
  run_number: number
  run_started_at?: string
  status: string
  conclusion?: string | null
  workflow_id: number
  html_url: string
  created_at: string
  updated_at: string
  repository: { full_name: string; owner: { login: string }; name: string }
  actor?: { login: string }
  head_commit?: { message: string; author?: { name: string } }
}

export interface GitHubStepPayload {
  name: string
  status: string
  conclusion?: string | null
  number: number
  started_at?: string | null
  completed_at?: string | null
}

export interface GitHubJobPayload {
  id: number
  name: string
  status: string
  conclusion?: string | null
  started_at?: string | null
  completed_at?: string | null
  html_url?: string
  runner_name?: string | null
  steps?: GitHubStepPayload[]
}

/** First line of a commit message; the card has one line to spend. */
function firstLine(text: string): string {
  return text.split("\n", 1)[0].trim()
}

export function mapGitHubRun(raw: GitHubRunPayload): Run {
  const fullName = raw.repository.full_name
  const [owner, name] = fullName.split("/")
  const id = String(raw.id)
  const commitMessage = raw.head_commit?.message

  return {
    provider: "github",
    key: `github:${fullName}:${id}`,
    id,
    number: raw.run_number,
    title: commitMessage ? firstLine(commitMessage) : (raw.display_title ?? raw.name ?? ""),
    pipeline: raw.name ?? "",
    branch: raw.head_branch,
    sha: raw.head_sha,
    status: fromGitHub(raw.status, raw.conclusion),
    isFailing: false,
    repo: { owner, name, fullName },
    actor: raw.actor?.login,
    commitMessage,
    webUrl: raw.html_url,
    createdAt: raw.created_at,
    startedAt: raw.run_started_at ?? undefined,
    finishedAt: undefined,
  }
}

function mapStep(raw: GitHubStepPayload): Step {
  return {
    name: raw.name,
    status: fromGitHub(raw.status, raw.conclusion),
    number: raw.number,
    startedAt: raw.started_at ?? undefined,
    finishedAt: raw.completed_at ?? undefined,
  }
}

export function mapGitHubJob(raw: GitHubJobPayload, runKey: string): Job {
  return {
    id: String(raw.id),
    runKey,
    name: raw.name,
    status: fromGitHub(raw.status, raw.conclusion),
    startedAt: raw.started_at ?? undefined,
    finishedAt: raw.completed_at ?? undefined,
    agent: raw.runner_name ?? undefined,
    webUrl: raw.html_url,
    steps: raw.steps?.map(mapStep),
  }
}

/**
 * A run that is still going but already has a failed job is doomed. Buildkite
 * reports this directly as the `failing` state; for GitHub it has to be
 * derived. Only meaningful while the run is in flight — a finished run already
 * carries its verdict in `status`.
 */
export function applyIsFailing(run: Run, jobs: Job[]): Run {
  if (isTerminal(run.status)) return run
  const failing = jobs.some((j) => j.status === "failed" || j.status === "timed_out")
  return failing ? { ...run, isFailing: true } : run
}
```

- [ ] **Step 5: Enable JSON imports if needed**

Run: `bun test src/providers/github-map.test.ts`

If it fails on the `import runsFixture from "../fixtures/github-runs.json"` lines under `tsc`, add to `tsconfig.json` `compilerOptions`: `"resolveJsonModule": true`. Bun itself imports JSON natively; this is only for the build.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/providers/github-map.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
bun run lint
git add src/providers/github-map.ts src/providers/github-map.test.ts src/fixtures tsconfig.json
git commit -m "feat: map gh api run payloads to the neutral model

Populates commitMessage and actor, which gh run list --json cannot
supply and which types.ts has always declared but never filled."
```

---

### Task 4: GitHubProvider, and migrate App and Dashboard onto the neutral model

The largest task, and necessarily atomic: TypeScript will not compile with the model half-migrated. The deliverable is **the app behaving exactly as it does today, on the neutral model, with no Buildkite yet**. A reviewer should be able to run it and see no user-visible change except richer commit titles.

**Files:**
- Create: `src/providers/types.ts`, `src/providers/github.ts`
- Delete: `src/github.ts`
- Modify: `src/app.ts`, `src/dashboard.ts`, `src/config.ts`, `src/config.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `CiProvider`, `Scope`, `ProviderDiagnostic`, `FetchResult`; `class GitHubProvider implements CiProvider`.

- [ ] **Step 1: Define the provider contract**

Create `src/providers/types.ts`:

```ts
import type { Job, Run } from "../types.js"

export interface Scope {
  /** "owner/repo" entries. */
  repositories: string[]
  /** GitHub organizations to expand into repositories. */
  organizations: string[]
  buildkite?: { org: string; pipelines: string[] }
}

/** Why a provider contributed nothing, for the log pane and empty state. */
export interface ProviderDiagnostic {
  provider: string
  level: "info" | "error"
  message: string
}

export interface FetchResult {
  runs: Run[]
  /**
   * Jobs keyed by Run.key, when the provider got them for free. Buildkite
   * embeds jobs in its build payloads; GitHub needs a call per run and
   * leaves this undefined.
   */
  jobs?: Map<string, Job[]>
  diagnostics: ProviderDiagnostic[]
}

export interface CiProvider {
  readonly name: string
  fetchRuns(scope: Scope): Promise<FetchResult>
  fetchJobs(run: Run): Promise<Job[]>
  cancel(run: Run): Promise<void>
  rerun(run: Run): Promise<void>
  logs(run: Run): Promise<string>
}
```

- [ ] **Step 2: Move `src/github.ts` to `src/providers/github.ts` as a provider**

`git mv src/github.ts src/providers/github.ts`, then rewrite it:

- Keep `listRepositories`, `listPullRequests`, `getAllPullRequests`, and the private cache helpers **unchanged** apart from import paths (`./types.js` → `../types.js`). The PR path stays on `gh pr list --json`: `statusCheckRollup`, `reviewDecision`, and `mergeable` are GraphQL-only and REST would cost extra calls per PR.
- Replace `listWorkflowRuns` with a `gh api` call and map through Task 3:

```ts
async fetchRuns(scope: Scope): Promise<FetchResult> {
  const runs: Run[] = []
  const diagnostics: ProviderDiagnostic[] = []

  for (const repo of scope.repositories) {
    const cacheKey = `runs:${repo}`
    const cached = this.getFromCache<Run[]>(cacheKey)
    if (cached) {
      runs.push(...cached)
      continue
    }
    try {
      const { stdout } = await execa(
        "gh",
        ["api", `repos/${repo}/actions/runs?per_page=${this.limit}`],
        { timeout: 10000 },
      )
      const payload = JSON.parse(stdout) as { workflow_runs: GitHubRunPayload[] }
      const mapped = (payload.workflow_runs ?? []).map(mapGitHubRun)
      this.setCache(cacheKey, mapped)
      runs.push(...mapped)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("API rate limit exceeded")) {
        diagnostics.push({
          provider: "github",
          level: "error",
          message: "GitHub: API rate limit exceeded",
        })
      } else {
        diagnostics.push({
          provider: "github",
          level: "error",
          message: `GitHub: could not list runs for ${repo}`,
        })
      }
    }
  }

  runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return { runs, diagnostics }
}
```

- `fetchJobs(run)` keeps the existing `gh api repos/{repo}/actions/runs/{id}/jobs` call, mapping each through `mapGitHubJob(raw, run.key)`.
- `cancel` / `rerun` / `logs` move in from `app.ts` verbatim as methods, using `run.repo.fullName` and `run.id`:
  - `cancel`: `gh run cancel ${run.id} -R ${run.repo.fullName}`
  - `rerun`: `gh run rerun ${run.id} -R ${run.repo.fullName}`
  - `logs`: `gh run view ${run.id} -R ${run.repo.fullName} --log`
- Set `readonly name = "github"`.

- [ ] **Step 3: Migrate `src/app.ts`**

- `private githubService: GitHubService` becomes `private providers: CiProvider[]`, holding one `GitHubProvider` for now.
- `watchedWorkflows: Set<number>` → `Set<string>`; `completedWorkflows: Map<number, WorkflowRun>` → `Map<string, Run>`. Key by `run.key` throughout, **not** `run.id` — ids are only unique within a provider.
- In `performRefresh`, replace `run.status !== "completed"` with `isActive(run.status)` and `run.status === "completed"` with `isTerminal(run.status)` (import from `../status.js`).
- Merge results from all providers, then sort by `createdAt` descending.
- After fetching jobs, run each visible run through `applyIsFailing(run, jobs)`.
- Job map keys become `run.key` instead of `run.id.toString()`.
- `dismissCompletedWorkflow(workflowId: number)` → `dismissRun(key: string)`; same for the dismiss-all variant.
- Delete the now-duplicated `gh run cancel` / `gh run rerun` / `gh run view --log` blocks; call `provider.cancel(run)` etc., selecting the provider by `run.provider`. Add a private helper:

```ts
private providerFor(run: Run): CiProvider | undefined {
  return this.providers.find((p) => p.name === run.provider)
}
```

- [ ] **Step 4: Migrate `src/dashboard.ts`**

- Delete the private `getStatusIcon` and `getStatusColor` methods (around lines 1925–1975) and import `statusIcon`, `statusColor`, `isTerminal`, `isActive` from `../status.js`. Every call site loses its second argument and passes `run.isFailing` instead: `this.getStatusIcon(w.status, w.conclusion)` → `statusIcon(w.status, w.isFailing)`.
- Replace `WorkflowRun`/`WorkflowJob` with `Run`/`Job` throughout.
- Field renames at the ~15 call sites: `workflow.repository.owner`/`.name` → `run.repo.owner`/`.name` (and prefer `run.repo.fullName` where the code concatenates them, e.g. lines 1150, 1732, 1762); `workflow.workflowName` → `run.pipeline`; `workflow.runNumber` → `run.number`; `workflow.headBranch` → `run.branch`; `workflow.htmlUrl` → `run.webUrl`.
- `workflow.conclusion` renders (line 1771-2) become: show `run.status.toUpperCase()` when `isTerminal(run.status)`.
- `updateStatusBar` (line ~1977): `w.status === "in_progress"` → `w.status === "running"`; `w.status === "queued" || w.status === "waiting"` → `w.status === "queued"`. Add a blocked count — a build paused for a human is the single most actionable thing on the screen.
- Step rendering (lines ~1854–1880) switches from `step.conclusion === "success"` to `step.status === "passed"` and so on. Where a job has no `steps`, render `job.command` on one line instead; where `job.type === "manual"` and `job.status === "blocked"`, render `waiting for unblock`.
- Prefs path (lines 2889, 2943): see Task 7. Leave as `.gh-hud-prefs.json` for now so this task stays about the model.
- Titles at lines 73, 1029, 1280: leave for Task 7.

- [ ] **Step 5: Update `src/config.ts` and its test**

`buildRepositoryList` takes `GitHubService`; change the parameter type to `GitHubProvider` and the import to `./providers/github.js`. In `src/config.test.ts`, update `githubReturningOrgRepo`'s cast and the import path accordingly. No behavioural change.

- [ ] **Step 6: Verify the build and the full suite**

```bash
bun run build
bun test
bun biome check .
```

Expected: `tsc` clean, all tests pass, biome clean. Fix any residual references to the old type names until all three are green.

- [ ] **Step 7: Verify the app actually runs**

From the repository root (the positional argument is a path to a checkout, not
an `owner/repo` slug):

```bash
bun dist/index.js .
```

Expected: the dashboard renders this repo's recent runs, cards show **commit message titles** (new — previously `display_title` only), navigation and `q` to quit work. Quit and confirm the terminal is restored.

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "refactor: migrate app and dashboard to the neutral run model

Behaviour is unchanged except that run cards now show commit message
titles, which the gh api migration makes available for the first time."
```

---

### Task 5: Buildkite payload mapping

Pure mapping, no network. Mirrors Task 3.

**Files:**
- Create: `src/providers/buildkite-map.ts`, `src/providers/buildkite-map.test.ts`
- Create: `src/fixtures/buildkite-builds.json`, `src/fixtures/buildkite-pipelines.json`

**Interfaces:**
- Consumes: `Run`, `Job` from `src/types.ts`; `fromBuildkite` from `src/status.ts`; `parseGitHubRemote` from `src/config.ts`.
- Produces: `mapBuildkiteBuild(raw: BuildkiteBuildPayload): Run`, `mapBuildkiteJob(raw: BuildkiteJobPayload, runKey: string): Job`, `indexPipelinesByRepo(pipelines: BuildkitePipelinePayload[]): Map<string, string[]>`, and the payload interfaces.

- [ ] **Step 1: Capture real fixtures**

Requires a token with `read_builds` and `read_pipelines`. **Do not pass `exclude_jobs`** — the embedded jobs are the point.

```bash
export BUILDKITE_API_TOKEN=<a token with read_builds, read_pipelines>
curl -sH "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  "https://api.buildkite.com/v2/organizations/ameriglide/builds?per_page=3" \
  > src/fixtures/buildkite-builds.json
curl -sH "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  "https://api.buildkite.com/v2/organizations/ameriglide/pipelines?per_page=5" \
  > src/fixtures/buildkite-pipelines.json
```

Verify the builds fixture really has jobs and pipeline info embedded:

```bash
jq -e '.[0] | (.jobs | length > 0) and (.pipeline.repository | length > 0)' src/fixtures/buildkite-builds.json
```

Expected: `true`. If `false`, the capture used `exclude_jobs`/`exclude_pipeline` — re-capture.

**Scrub the fixtures before committing.** Build payloads contain `creator.email` and `env`. Replace real emails with `someone@example.com` and empty any `env` object. The commit messages are fine to keep.

- [ ] **Step 2: Write the failing test**

Create `src/providers/buildkite-map.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import buildsFixture from "../fixtures/buildkite-builds.json"
import pipelinesFixture from "../fixtures/buildkite-pipelines.json"
import {
  indexPipelinesByRepo,
  mapBuildkiteBuild,
  mapBuildkiteJob,
  type BuildkiteBuildPayload,
} from "./buildkite-map.js"

const rawBuild = buildsFixture[0] as unknown as BuildkiteBuildPayload

describe("mapBuildkiteBuild", () => {
  test("produces a buildkite-provider run keyed by repo and build uuid", () => {
    const run = mapBuildkiteBuild(rawBuild)
    expect(run.provider).toBe("buildkite")
    expect(run.id).toBe(rawBuild.id)
    expect(run.key).toBe(`buildkite:${run.repo.fullName}:${run.id}`)
  })

  test("derives the repository from the pipeline's git remote", () => {
    const run = mapBuildkiteBuild(rawBuild)
    expect(run.repo.fullName).toMatch(/^[^/]+\/[^/]+$/)
    expect(run.repo.fullName).not.toContain(".git")
  })

  test("carries the pipeline slug needed by the write endpoints", () => {
    expect(mapBuildkiteBuild(rawBuild).pipelineSlug).toBe(rawBuild.pipeline.slug)
  })

  // Buildkite's `message` is the full commit message; these are routinely
  // many paragraphs long in this org.
  test("takes the title from the first line and keeps the full message", () => {
    const build = { ...rawBuild, message: "short subject\n\nlong body" }
    const run = mapBuildkiteBuild(build)
    expect(run.title).toBe("short subject")
    expect(run.commitMessage).toBe("short subject\n\nlong body")
  })

  test("marks a failing build as running-but-doomed", () => {
    const run = mapBuildkiteBuild({ ...rawBuild, state: "failing" })
    expect(run.status).toBe("running")
    expect(run.isFailing).toBe(true)
  })

  test("surfaces blocked builds as blocked", () => {
    expect(mapBuildkiteBuild({ ...rawBuild, state: "blocked" }).status).toBe("blocked")
  })

  test("embeds jobs into the run's own key space", () => {
    const run = mapBuildkiteBuild(rawBuild)
    const job = mapBuildkiteJob(rawBuild.jobs[0], run.key)
    expect(job.runKey).toBe(run.key)
    expect(job.steps).toBeUndefined()
  })
})

describe("mapBuildkiteJob", () => {
  test("keeps the command, since Buildkite jobs have no steps", () => {
    const job = mapBuildkiteJob(rawBuild.jobs[0], "buildkite:acme/widgets:x")
    expect(job.steps).toBeUndefined()
    expect(typeof job.id).toBe("string")
  })

  test("preserves the job type so manual gates can be rendered", () => {
    const job = mapBuildkiteJob({ ...rawBuild.jobs[0], type: "manual", state: "blocked" }, "k")
    expect(job.type).toBe("manual")
    expect(job.status).toBe("blocked")
  })
})

describe("indexPipelinesByRepo", () => {
  test("maps owner/repo to pipeline slugs", () => {
    const index = indexPipelinesByRepo(pipelinesFixture as never)
    expect(index.size).toBeGreaterThan(0)
    for (const [repo, slugs] of index) {
      expect(repo).toMatch(/^[^/]+\/[^/]+$/)
      expect(slugs.length).toBeGreaterThan(0)
    }
  })

  // Several pipelines can build the same repository; none may be lost.
  test("collects every pipeline for a repository", () => {
    const index = indexPipelinesByRepo([
      { slug: "a", name: "A", repository: "git@github.com:acme/widgets.git" },
      { slug: "b", name: "B", repository: "https://github.com/acme/widgets" },
    ] as never)
    expect(index.get("acme/widgets")).toEqual(["a", "b"])
  })

  test("ignores pipelines whose remote is not GitHub", () => {
    const index = indexPipelinesByRepo([
      { slug: "x", name: "X", repository: "git@gitlab.com:acme/widgets.git" },
    ] as never)
    expect(index.size).toBe(0)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/providers/buildkite-map.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Create `src/providers/buildkite-map.ts`:

```ts
import { parseGitHubRemote } from "../config.js"
import { fromBuildkite } from "../status.js"
import type { Job, Run } from "../types.js"

export interface BuildkitePipelinePayload {
  slug: string
  name: string
  repository: string
}

export interface BuildkiteJobPayload {
  id: string
  type?: string
  name?: string
  label?: string
  state: string
  command?: string
  web_url?: string
  agent?: { name?: string } | null
  started_at?: string | null
  finished_at?: string | null
}

export interface BuildkiteBuildPayload {
  id: string
  number: number
  state: string
  message?: string
  commit: string
  branch: string
  web_url: string
  created_at: string
  started_at?: string | null
  finished_at?: string | null
  creator?: { name?: string } | null
  pipeline: BuildkitePipelinePayload
  jobs: BuildkiteJobPayload[]
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0].trim()
}

/**
 * Pipelines store their repository as a git remote — `git@github.com:o/r.git`
 * or the https form. `parseGitHubRemote` already handles both and strips
 * `.git`, so the same parser that resolves a local checkout resolves a
 * pipeline. Non-GitHub remotes simply do not participate.
 */
export function indexPipelinesByRepo(
  pipelines: BuildkitePipelinePayload[],
): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const pipeline of pipelines) {
    const repo = parseGitHubRemote(pipeline.repository ?? "")
    if (!repo) continue
    const slugs = index.get(repo)
    if (slugs) slugs.push(pipeline.slug)
    else index.set(repo, [pipeline.slug])
  }
  return index
}

export function mapBuildkiteBuild(raw: BuildkiteBuildPayload): Run {
  const fullName = parseGitHubRemote(raw.pipeline.repository ?? "") ?? raw.pipeline.slug
  const [owner = "", name = fullName] = fullName.split("/")
  const message = raw.message ?? ""

  return {
    provider: "buildkite",
    key: `buildkite:${fullName}:${raw.id}`,
    id: raw.id,
    number: raw.number,
    title: message ? firstLine(message) : raw.pipeline.name,
    pipeline: raw.pipeline.name,
    pipelineSlug: raw.pipeline.slug,
    branch: raw.branch,
    sha: raw.commit,
    status: fromBuildkite(raw.state),
    // Buildkite reports this directly; GitHub has to derive it from jobs.
    isFailing: raw.state === "failing",
    repo: { owner, name, fullName },
    actor: raw.creator?.name ?? undefined,
    commitMessage: message || undefined,
    webUrl: raw.web_url,
    createdAt: raw.created_at,
    startedAt: raw.started_at ?? undefined,
    finishedAt: raw.finished_at ?? undefined,
  }
}

const JOB_TYPES = new Set(["script", "manual", "trigger", "waiter"])

export function mapBuildkiteJob(raw: BuildkiteJobPayload, runKey: string): Job {
  const type = raw.type && JOB_TYPES.has(raw.type) ? (raw.type as Job["type"]) : undefined
  return {
    id: raw.id,
    runKey,
    // Buildkite jobs are frequently named only by an emoji label.
    name: raw.name ?? raw.label ?? raw.command ?? "(unnamed)",
    status: fromBuildkite(raw.state),
    startedAt: raw.started_at ?? undefined,
    finishedAt: raw.finished_at ?? undefined,
    agent: raw.agent?.name ?? undefined,
    webUrl: raw.web_url,
    command: raw.command,
    type,
    // Deliberately no `steps`: a Buildkite job IS a step.
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/providers/buildkite-map.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
bun run lint
git add src/providers/buildkite-map.ts src/providers/buildkite-map.test.ts src/fixtures
git commit -m "feat: map Buildkite build and pipeline payloads to the neutral model"
```

---

### Task 6: BuildkiteProvider — token, org, pipelines, builds, and actions

**Files:**
- Create: `src/providers/buildkite.ts`, `src/providers/buildkite-config.test.ts`
- Modify: `src/config.ts` (Buildkite config accessors)

**Interfaces:**
- Consumes: `CiProvider`, `Scope`, `FetchResult`, `ProviderDiagnostic` (Task 4); the mappers (Task 5).
- Produces: `resolveBuildkiteToken(env, config): string | undefined`, `class BuildkiteProvider implements CiProvider`, `BuildkiteProviderOptions`.

- [ ] **Step 1: Write the failing test for token resolution and diagnostics**

Create `src/providers/buildkite-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { BuildkiteProvider, resolveBuildkiteToken } from "./buildkite.js"
import type { Scope } from "./types.js"

const emptyScope: Scope = { repositories: [], organizations: [] }

describe("resolveBuildkiteToken", () => {
  test("prefers the environment variable over config", () => {
    expect(resolveBuildkiteToken({ BUILDKITE_API_TOKEN: "env" }, { token: "cfg" })).toBe("env")
  })

  test("falls back to config", () => {
    expect(resolveBuildkiteToken({}, { token: "cfg" })).toBe("cfg")
  })

  test("returns undefined when neither is set", () => {
    expect(resolveBuildkiteToken({}, {})).toBeUndefined()
    expect(resolveBuildkiteToken({}, undefined)).toBeUndefined()
  })

  // An empty string in config is a half-finished edit, not a token.
  test("treats blank values as absent", () => {
    expect(resolveBuildkiteToken({ BUILDKITE_API_TOKEN: "  " }, { token: "" })).toBeUndefined()
  })
})

describe("BuildkiteProvider without a token", () => {
  // The tool must stay installable and useful for people with no Buildkite
  // account at all, so this path is a skip, not an error.
  test("skips quietly and contributes nothing", async () => {
    const provider = new BuildkiteProvider({ token: undefined })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].level).toBe("info")
    expect(result.diagnostics[0].message).toContain("no token")
  })
})

describe("BuildkiteProvider with a failing token", () => {
  // The opposite rule: a token that is present and broken must be loud, or a
  // misconfiguration is indistinguishable from an idle CI system.
  test("reports a rejected token as an error", async () => {
    const provider = new BuildkiteProvider({
      token: "bad",
      org: "acme",
      fetch: async () => new Response("", { status: 401 }),
    })
    const result = await provider.fetchRuns({ ...emptyScope, buildkite: { org: "acme", pipelines: [] } })
    expect(result.runs).toEqual([])
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("rejected")
  })

  test("reports an ambiguous organization", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      fetch: async () =>
        new Response(JSON.stringify([{ slug: "one" }, { slug: "two" }]), { status: 200 }),
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("one")
    expect(result.diagnostics[0].message).toContain("two")
  })

  test("auto-detects a sole organization", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      fetch: async (url: string) => {
        if (url.endsWith("/organizations")) {
          return new Response(JSON.stringify([{ slug: "ameriglide" }]), { status: 200 })
        }
        return new Response(JSON.stringify([]), { status: 200 })
      },
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics.some((d) => d.level === "error")).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/providers/buildkite-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/providers/buildkite.ts`. Key points, in order:

1. **Injectable `fetch`.** `BuildkiteProviderOptions` takes an optional `fetch` so tests never touch the network:

```ts
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface BuildkiteProviderOptions {
  token?: string
  org?: string
  pipelines?: string[]
  fetch?: FetchLike
}

const API = "https://api.buildkite.com/v2"

export function resolveBuildkiteToken(
  env: Record<string, string | undefined>,
  config: { token?: string } | undefined,
): string | undefined {
  const fromEnv = env.BUILDKITE_API_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const fromConfig = config?.token?.trim()
  return fromConfig ? fromConfig : undefined
}
```

2. **A paginating request helper** that follows `Link: rel="next"`:

```ts
private async getAll<T>(path: string): Promise<T[]> {
  const out: T[] = []
  let url: string | undefined = `${API}${path}`
  while (url) {
    const response = await this.fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (response.status === 401 || response.status === 403) {
      throw new TokenRejected()
    }
    if (!response.ok) {
      throw new Error(`Buildkite ${response.status}`)
    }
    out.push(...((await response.json()) as T[]))
    url = nextLink(response.headers.get("link"))
  }
  return out
}
```

with a module-level parser:

```ts
/** Extracts the rel="next" URL from an RFC 5988 Link header. */
export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return undefined
}
```

3. **Org resolution.** If `org` is configured, use it. Otherwise `GET /organizations`: exactly one → use its slug; zero → error diagnostic `Buildkite: token reaches no organizations`; several → error diagnostic `Buildkite: several orgs reachable (a, b) — set buildkite.org or --bk-org`. Cache the resolved org for the process lifetime.

4. **`fetchRuns(scope)`**, following the spec's endpoint split:
   - No token → one `info` diagnostic, `Buildkite: no token ($BUILDKITE_API_TOKEN or buildkite.token) — skipped`, empty runs. Return immediately.
   - Resolve the org (above).
   - Fetch and cache the pipeline index: `GET /organizations/{org}/pipelines?per_page=100`, through `indexPipelinesByRepo`. Refresh it at most once every 5 minutes — pipelines change far more slowly than builds.
   - **If `scope.repositories` is non-empty**: map each repo through the index to slugs. For a repo with no slugs, emit an `info` diagnostic `Buildkite: no pipeline in {org} builds {owner}/{repo}`. Fetch `GET /organizations/{org}/pipelines/{slug}/builds?per_page={limit}` per slug.
   - **Otherwise**: one `GET /organizations/{org}/builds?per_page={limit}`.
   - Never append `exclude_jobs`.
   - Map builds via `mapBuildkiteBuild`, jobs via `mapBuildkiteJob` into a `Map<string, Job[]>` keyed by `run.key`, and return both.
   - Catch `TokenRejected` → `error` diagnostic `Buildkite: token rejected — check scopes (needs read_builds, read_pipelines)`.

5. **`fetchJobs(run)`** returns `[]` — jobs always arrive with the build. Document that in a comment.

6. **Actions**, all requiring `run.pipelineSlug`:
   - `cancel`: `PUT /organizations/{org}/pipelines/{slug}/builds/{number}/cancel`
   - `rerun`: `PUT /organizations/{org}/pipelines/{slug}/builds/{number}/rebuild`
   - `logs`: fetch the build, take the first job with a `log_url`, `GET` it, return `content`.

   `PUT` is what the Buildkite REST reference documents for both, with matching
   curl examples. Be aware that Buildkite's own documentation *also* contains a
   `POST` entry for rebuild, so the two disagree. Verify against the live API
   before trusting either:

   ```bash
   curl -sI -X PUT -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
     "https://api.buildkite.com/v2/organizations/ameriglide/pipelines/<slug>/builds/<n>/cancel" | head -1
   ```

   A `405 Method Not Allowed` means the verb is wrong — switch that call to
   `POST`. Do not guess; make the code match what the API actually accepts.
   Use an already-finished build so the cancel is a no-op.

7. `readonly name = "buildkite"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/providers/buildkite-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the config accessors**

In `src/config.ts`, add to `ConfigManager`:

```ts
get buildkite(): BuildkiteConfig {
  return this.config.buildkite ?? {}
}
```

and include `buildkite: {}` in `DEFAULT_CONFIG`.

- [ ] **Step 6: Run the full suite**

Run: `bun test && bun run build && bun biome check .`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/providers/buildkite.ts src/providers/buildkite-config.test.ts src/config.ts
git commit -m "feat: add the Buildkite provider

Scoped runs fetch per-pipeline because the org-wide builds endpoint has
no pipeline filter and would push a single repo's builds out of the
window. A missing token skips silently; a rejected one is reported."
```

---

### Task 7: Wire Buildkite into the app, with diagnostics and CLI flags

**Files:**
- Modify: `src/app.ts`, `src/index.ts`, `src/dashboard.ts`

**Interfaces:**
- Consumes: `BuildkiteProvider` (Task 6), `ProviderDiagnostic` (Task 4).
- Produces: no new exports; behavioural wiring only.

- [ ] **Step 1: Construct both providers**

In `App.initialize`, build the provider list from config and flags:

```ts
this.providers = []
if (!args.noGithub) this.providers.push(new GitHubProvider())
if (!args.noBuildkite) {
  this.providers.push(
    new BuildkiteProvider({
      token: resolveBuildkiteToken(process.env, this.configManager.buildkite),
      org: args.bkOrg ?? this.configManager.buildkite.org,
      pipelines: args.pipelines ?? this.configManager.buildkite.pipelines,
    }),
  )
}
```

- [ ] **Step 2: Fan out, merge, and surface diagnostics**

In `performRefresh`, replace the single `getAllRecentWorkflows` call with:

```ts
const scope: Scope = {
  repositories: this.repositories,
  organizations: this.configManager.organizations,
}

const results = await Promise.all(this.providers.map((p) => p.fetchRuns(scope)))

const allRuns = results
  .flatMap((r) => r.runs)
  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

// Jobs a provider handed us for free (Buildkite embeds them in builds).
const embeddedJobs = new Map<string, Job[]>()
for (const result of results) {
  for (const [key, jobs] of result.jobs ?? []) embeddedJobs.set(key, jobs)
}

this.lastDiagnostics = results.flatMap((r) => r.diagnostics)
for (const diagnostic of this.lastDiagnostics) {
  this.dashboard.log(diagnostic.message, diagnostic.level)
}
```

Then, when fetching jobs for visible runs, **skip any run whose key is already in `embeddedJobs`** — that is the whole point of the paired return, and re-fetching would turn one Buildkite request into forty.

- [ ] **Step 3: Show diagnostics in the empty state**

Add `private lastDiagnostics: ProviderDiagnostic[] = []` to `App` and pass it to the dashboard alongside the runs. In `Dashboard`, when the grid has **no cards at all**, render the diagnostics in the empty-state panel beneath the existing instructions. Without this, a Buildkite misconfiguration on an `inetalliance/*` checkout — which has no Actions runs by design — is indistinguishable from an idle CI system.

- [ ] **Step 4: Add the CLI flags**

In `src/index.ts`, extend `WatchOptions` and `addWatchOptions`:

```ts
.option("--bk-org <org>", "Buildkite organization slug")
.option("--pipeline <slugs...>", "Buildkite pipeline slugs to watch")
.option("--no-buildkite", "Disable the Buildkite provider")
.option("--no-github", "Disable the GitHub provider")
```

Note commander's convention: `--no-buildkite` populates `options.buildkite` as `false`, so read `args.noBuildkite = options.buildkite === false`.

- [ ] **Step 5: Verify against the real thing**

```bash
bun run build
export BUILDKITE_API_TOKEN=<token with read_builds, read_pipelines>
bun dist/index.js ~/Projects/usm
```

Expected: the grid shows `site-content-usm` builds. Confirm on screen:
- cards render with commit-message titles and the pipeline name,
- the status bar counts running/queued/blocked,
- `bun dist/index.js .` in *this* repo still shows GitHub Actions runs,
- unsetting the token shows the GitHub-only dashboard plus one `info` line about the missing token, and no error.

Then deliberately break it and confirm the failure is loud:

```bash
BUILDKITE_API_TOKEN=nonsense bun dist/index.js ~/Projects/usm
```
Expected: an **error** line naming a rejected token — not an empty, silent grid.

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/index.ts src/dashboard.ts
git commit -m "feat: show Buildkite builds alongside GitHub Actions runs"
```

---

### Task 8: Provider-aware actions

**Files:**
- Modify: `src/app.ts`, `src/dashboard.ts`

- [ ] **Step 1: Route every action through the run's provider**

In `App.setupEventHandlers`, the kill/rerun/logs handlers resolve the provider from the run and delegate:

```ts
this.dashboard.onKillRun(async (run: Run) => {
  const provider = this.providerFor(run)
  if (!provider) return
  try {
    await provider.cancel(run)
    this.dashboard.log(`Cancelled ${run.pipeline} #${run.number}`, "info")
    await this.performRefresh(true)
  } catch (error) {
    this.dashboard.log(`Failed to cancel: ${error}`, "error")
  }
})
```

Same shape for rerun and logs. Open-in-browser already uses `run.webUrl` and needs no provider branch.

- [ ] **Step 2: Make the confirmation dialog provider-accurate**

`showKillConfirmation` (dashboard.ts ~1144) says "workflow run". Make the noun follow the provider: `run.provider === "buildkite" ? "build" : "workflow run"`. Same for the contextual shortcut labels (`getContextualShortcuts`, ~2092) — "rerun" on GitHub, "rebuild" on Buildkite.

- [ ] **Step 3: Verify by hand**

With a real Buildkite build selected, press the rerun key and confirm a new build appears in the org; press the kill key on a running build and confirm it cancels. Confirm the same keys still work on a GitHub run in this repo.

Do this against a harmless pipeline — prefer `beejax-platform-credential-check` over anything that deploys.

- [ ] **Step 4: Commit**

```bash
git add src/app.ts src/dashboard.ts
git commit -m "feat: route cancel, rerun and logs through the run's provider"
```

---

### Task 9: The rename, cleanup, and docs

Last, so that every preceding task ran against a stable name.

**Files:**
- Modify: `package.json`, `src/index.ts`, `src/config.ts`, `src/dashboard.ts`, `src/config.test.ts`, `src/docker-utils.test.ts`, `README.md`, `TODO.md`, `.gitignore`
- Rename: `example.gh-hud.json` → `example.ops-hud.json`
- Delete: `bin/gh-hud.js`, `test-fixes.js`, `test-fixes.cjs`, `test-kill.js`, `test-api.js`, `test-github.js`, `test-docker.js`, `test-docker-format.js`, `debug-blessed.js`, `FIXES_APPLIED.md`

- [ ] **Step 1: Write the failing test for config path fallback**

Add to `src/config.test.ts`:

```ts
describe("config path migration", () => {
  // Existing gh-hud users must not silently lose their configuration to the
  // rename; the new name wins, the old one still works.
  test("reads a legacy .gh-hud.json when no new config exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ops-hud-"))
    await writeFile(join(dir, ".gh-hud.json"), JSON.stringify({ maxWorkflows: 7 }))
    const manager = new ConfigManager()
    await manager.loadConfig(undefined, dir)
    expect(manager.maxWorkflows).toBe(7)
  })

  test("prefers .ops-hud.json when both exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ops-hud-"))
    await writeFile(join(dir, ".gh-hud.json"), JSON.stringify({ maxWorkflows: 7 }))
    await writeFile(join(dir, ".ops-hud.json"), JSON.stringify({ maxWorkflows: 9 }))
    const manager = new ConfigManager()
    await manager.loadConfig(undefined, dir)
    expect(manager.maxWorkflows).toBe(9)
  })
})
```

This requires `loadConfig` to take an optional base directory for testability — add `baseDir = process.cwd()` as a second parameter and resolve the relative candidates against it.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL — `loadConfig` takes one argument / legacy path not read.

- [ ] **Step 3: Update the config paths**

In `src/config.ts`, the candidate list becomes, in order:

```ts
const paths = [
  configPath,
  join(baseDir, ".ops-hud.json"),
  join(homedir(), ".ops-hud.json"),
  join(homedir(), ".config", "ops-hud", "config.json"),
  // Legacy gh-hud locations, kept so the 2.0 rename doesn't silently drop
  // an existing user's configuration.
  join(baseDir, ".gh-hud.json"),
  join(homedir(), ".gh-hud.json"),
  join(homedir(), ".config", "gh-hud", "config.json"),
].filter(Boolean) as string[]
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Migrate the prefs file**

In `src/dashboard.ts` (lines ~2889 and ~2943), read `~/.ops-hud-prefs.json`, falling back to `~/.gh-hud-prefs.json` when the new file is absent; always **write** the new path. Add a brief comment saying why.

- [ ] **Step 6: Rename everything else**

```bash
git rm bin/gh-hud.js test-fixes.js test-fixes.cjs test-kill.js \
       test-api.js test-github.js test-docker.js test-docker-format.js \
       debug-blessed.js FIXES_APPLIED.md
git mv example.gh-hud.json example.ops-hud.json
```

`bin/gh-hud.js` goes rather than being renamed: `.npmignore` excludes `bin/` and `package.json`'s `bin` points at `./dist/index.js`, so it has never shipped.

In `package.json`: `name` → `ops-hud`; `version` → `2.0.0`; `bin` → `{ "ops-hud": "./dist/index.js" }`; `description` → `"CI and ops dashboard for the terminal — GitHub Actions and Buildkite"`; the `gh-hud` script entry → `ops-hud`; `repository`/`bugs`/`homepage` URLs → `mquinnv/ops-hud`; add `"buildkite"` and `"ci"` to `keywords`.

In `src/index.ts`: `program.name("ops-hud")` and the matching description.

In `src/dashboard.ts`: line ~73 `"GitHub Workflow Monitor"` → `"Ops HUD"`; line ~1029 help header likewise; line ~1280 `"GitHub HUD started"` → `"Ops HUD started"`.

Then sweep for stragglers:

```bash
grep -rniI --exclude-dir={node_modules,dist,.git} -e 'gh-hud' -e 'gh_hud' -e 'ghhud' .
```

Every remaining hit must be either an intentional legacy-fallback path in `config.ts`/`dashboard.ts`, a line in `README.md` documenting the rename, or `bun.lock` (regenerated below).

- [ ] **Step 7: Rewrite the docs**

`README.md`: retitle to `ops-hud`, update every `gh-hud` command and install line, document the Buildkite section (token via `$BUILDKITE_API_TOKEN` preferred over `buildkite.token` in config, org auto-detection, required scopes `read_builds`/`read_pipelines` plus `write_builds` for cancel/rebuild and `read_build_logs` for logs), the new flags, and add a short "Upgrading from gh-hud" note covering the binary rename and the config/prefs fallback. Update `example.ops-hud.json` with a `buildkite` block. Update `TODO.md`'s stale reference.

- [ ] **Step 8: Regenerate the lockfile and verify everything**

```bash
bun install
bun run build
bun test
bun biome check .
bun dist/index.js .
```

Expected: all green; the dashboard runs; the help header reads "Ops HUD".

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat!: rename gh-hud to ops-hud

BREAKING CHANGE: the binary is now ops-hud and config lives in
.ops-hud.json. The gh-hud config and prefs paths are still read as
fallbacks, so existing setups keep working.

Also removes eight unreferenced scratch files and the bin/ shim, which
.npmignore already excluded from the published package."
```

---

## Post-implementation (needs Michael, not an agent)

These are release actions with external side effects. Do not perform them as part of plan execution — surface them and let Michael decide.

- Rename the GitHub repository `mquinnv/gh-hud` → `mquinnv/ops-hud` (GitHub redirects the old URL).
- `npm publish` the `ops-hud` package at 2.0.0 (the release workflow uses OIDC trusted publishing — confirm the new package name is registered as a trusted publisher first, or the workflow will fail).
- `npm deprecate gh-hud "renamed to ops-hud"`.

---

## Self-Review

**Spec coverage.** Each spec section maps to a task: §1 neutral model → Tasks 1–2; §2 provider interface and fetch economics → Tasks 4, 6; §3 `gh api` migration → Task 3 (mapping) and Task 4 (call site); §4 scoping, config, token precedence → Tasks 5–7, with the silent-empty-grid diagnostics table realised in Task 6 step 3 and Task 7 steps 2–3 and verified in Task 7 step 5; §5 the rename → Task 9; §6 cleanup → Task 9 step 6. Testing section → the test steps in Tasks 1, 3, 5, 6, 9.

**Known deviation from the spec.** The spec's §2 table gives Buildkite's cancel and rebuild as `POST`. The REST reference documents `PUT` for both, with matching curl examples — and Buildkite's own docs contain a contradictory `POST` entry for rebuild. The plan therefore specifies `PUT` and Task 6 step 3 verifies it live, with instructions to correct the code on a 405. Trust the verified call over any document, including this plan.

**Risk concentration.** Task 4 is the large one, by necessity — the type migration cannot be partially applied and still compile. It has an explicit run-the-app verification step (Task 4 step 7) so a reviewer can confirm no behavioural regression before any Buildkite code lands.
