import { describe, expect, test } from "bun:test"
import { App } from "./app.js"
import type { Dashboard } from "./dashboard.js"
import type { CiProvider, FetchResult, Scope } from "./providers/types.js"
import type { RunStatus } from "./status.js"
import type { Job, Provider, Run } from "./types.js"

// ---------------------------------------------------------------------------
// Doubles. Everything the App reaches for is injected, so nothing here touches
// a network, a `gh` binary or the terminal.
// ---------------------------------------------------------------------------

function makeRun(partial: Partial<Run> = {}): Run {
  const provider: Provider = partial.provider ?? "github"
  const id = partial.id ?? "1"
  const fullName = partial.repo?.fullName ?? "acme/widgets"
  const [owner, name] = fullName.split("/")

  return {
    provider,
    key: `${provider}:${fullName}:${id}`,
    id,
    number: 1,
    title: "a commit title",
    pipeline: "CI",
    branch: "main",
    sha: "0123456789abcdef",
    status: "running",
    isFailing: false,
    repo: { owner, name, fullName },
    webUrl: "https://example.test/run",
    createdAt: "2026-09-17T10:00:00Z",
    ...partial,
  }
}

function makeJob(runKey: string, status: RunStatus, id = "j1"): Job {
  return { id, key: `${runKey}:${id}`, runKey, name: `job ${id}`, status }
}

class FakeProvider implements CiProvider {
  fetchRunsCalls = 0
  fetchJobsFor: string[] = []
  olderResult: FetchResult = { runs: [], diagnostics: [] }

  constructor(
    readonly name: string,
    private runs: Run[] = [],
    private jobs: Map<string, Job[]> = new Map(),
    private embedJobs = false,
    private diagnostics: FetchResult["diagnostics"] = [],
  ) {}

  setRuns(runs: Run[]): void {
    this.runs = runs
  }

  async fetchRuns(_scope: Scope): Promise<FetchResult> {
    this.fetchRunsCalls++
    return {
      runs: this.runs,
      jobs: this.embedJobs ? this.jobs : undefined,
      diagnostics: this.diagnostics,
    }
  }

  async fetchJobs(run: Run): Promise<Job[]> {
    this.fetchJobsFor.push(run.key)
    return this.jobs.get(run.key) ?? []
  }

  async cancel(): Promise<void> {}
  async rerun(): Promise<void> {}
  async logs(): Promise<string> {
    return ""
  }
}

/** A provider that can page backwards, for the resurrect path. */
class PagingProvider extends FakeProvider {
  async fetchOlderRuns(): Promise<FetchResult> {
    return this.olderResult
  }
}

function makeDashboard() {
  const rendered: Array<{ runs: Run[]; jobs: Map<string, Job[]> }> = []
  const logs: string[] = []

  const dashboard = {
    isModalOpen: () => false,
    showLoadingInStatus() {},
    stopRefreshAnimation() {},
    showError() {},
    log(message: string) {
      logs.push(message)
    },
    updateWorkflows(runs: Run[], jobs: Map<string, Job[]>) {
      rendered.push({ runs, jobs })
    },
    getCurrentWorkflows(): Run[] {
      return rendered.at(-1)?.runs ?? []
    },
  }

  return { dashboard: dashboard as unknown as Dashboard, rendered, logs }
}

interface AppInternals {
  repositories: string[]
  oldestWorkflowTimestamp?: string
  watchedWorkflows: Set<string>
  completedWorkflows: Map<string, Run>
  performRefresh(isManual?: boolean): Promise<void>
  dismissRun(key: string): void
  dismissAllCompletedRuns(runs: Run[]): void
}

function makeApp(providers: CiProvider[]) {
  const { dashboard, rendered, logs } = makeDashboard()
  const app = new App({ providers, dashboard })
  const internals = app as unknown as AppInternals
  internals.repositories = ["acme/widgets"]
  return { app, internals, rendered, logs }
}

const visibleKeys = (rendered: Array<{ runs: Run[] }>): string[] =>
  (rendered.at(-1)?.runs ?? []).map((run) => run.key)

// ---------------------------------------------------------------------------

describe("performRefresh visibility", () => {
  test("an in-flight run is shown and watched", async () => {
    const run = makeRun({ status: "running" })
    const { internals, rendered } = makeApp([new FakeProvider("github", [run])])

    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([run.key])
    expect(internals.watchedWorkflows.has(run.key)).toBe(true)
    expect(internals.completedWorkflows.has(run.key)).toBe(false)
  })

  test("a finished run nobody watched stays off the grid", async () => {
    const run = makeRun({ status: "passed" })
    const { internals, rendered } = makeApp([new FakeProvider("github", [run])])

    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([])
    expect(internals.watchedWorkflows.has(run.key)).toBe(false)
  })

  test("a run that finishes while watched stays up until it is dismissed", async () => {
    const running = makeRun({ status: "running" })
    const provider = new FakeProvider("github", [running])
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    provider.setRuns([{ ...running, status: "passed" }])
    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([running.key])
    expect(internals.completedWorkflows.has(running.key)).toBe(true)
  })

  // Native ids collide across providers; only the composite key is safe.
  test("identity is the composite key, not the native id", async () => {
    const mine = makeRun({ provider: "github", id: "7", status: "running" })
    const theirs = makeRun({ provider: "buildkite", id: "7", status: "passed" })
    const { internals, rendered } = makeApp([new FakeProvider("github", [mine, theirs])])

    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([mine.key])
    expect([...internals.watchedWorkflows]).toEqual(["github:acme/widgets:7"])
    expect(internals.watchedWorkflows.has("7")).toBe(false)
  })
})

describe("dismissal", () => {
  test("dismissing a run drops it from both trackers and from the grid", async () => {
    const running = makeRun({ status: "running" })
    const provider = new FakeProvider("github", [running])
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    provider.setRuns([{ ...running, status: "passed" }])
    await internals.performRefresh()

    internals.dismissRun(running.key)

    expect(internals.completedWorkflows.has(running.key)).toBe(false)
    expect(internals.watchedWorkflows.has(running.key)).toBe(false)
    expect(visibleKeys(rendered)).toEqual([])
  })

  test("dismiss-all clears every finished run and leaves the in-flight one", async () => {
    const finished = makeRun({ id: "1", status: "running" })
    const active = makeRun({ id: "2", status: "running" })
    const provider = new FakeProvider("github", [finished, active])
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    provider.setRuns([{ ...finished, status: "failed" }, active])
    await internals.performRefresh()

    const terminal = (rendered.at(-1)?.runs ?? []).filter((run) => run.status === "failed")
    internals.dismissAllCompletedRuns(terminal)

    expect(internals.completedWorkflows.size).toBe(0)
    expect(visibleKeys(rendered)).toEqual([active.key])
    expect(internals.watchedWorkflows.has(active.key)).toBe(true)
  })
})

describe("isFailing", () => {
  test("an in-flight run with a failed job is flagged", async () => {
    const run = makeRun({ status: "running" })
    const jobs = new Map([
      [run.key, [makeJob(run.key, "passed", "a"), makeJob(run.key, "failed", "b")]],
    ])
    const { internals, rendered } = makeApp([new FakeProvider("github", [run], jobs)])

    await internals.performRefresh()

    expect(rendered.at(-1)?.runs[0].isFailing).toBe(true)
  })

  test("a healthy in-flight run is not", async () => {
    const run = makeRun({ status: "running" })
    const jobs = new Map([
      [run.key, [makeJob(run.key, "passed", "a"), makeJob(run.key, "running", "b")]],
    ])
    const { internals, rendered } = makeApp([new FakeProvider("github", [run], jobs)])

    await internals.performRefresh()

    expect(rendered.at(-1)?.runs[0].isFailing).toBe(false)
  })

  test("a finished run is never flagged — its status already carries the verdict", async () => {
    const run = makeRun({ status: "running" })
    const jobs = new Map([[run.key, [makeJob(run.key, "failed", "a")]]])
    const provider = new FakeProvider("github", [run], jobs)
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    provider.setRuns([{ ...run, status: "failed" }])
    await internals.performRefresh()

    expect(rendered.at(-1)?.runs[0].status).toBe("failed")
    expect(rendered.at(-1)?.runs[0].isFailing).toBe(false)
  })
})

describe("multiple providers", () => {
  test("runs from every provider merge into one list, newest first", async () => {
    const older = makeRun({ provider: "github", id: "1", createdAt: "2026-09-17T09:00:00Z" })
    const newer = makeRun({ provider: "buildkite", id: "2", createdAt: "2026-09-17T11:00:00Z" })
    const { internals, rendered } = makeApp([
      new FakeProvider("github", [older]),
      new FakeProvider("buildkite", [newer]),
    ])

    await internals.performRefresh()

    expect(visibleKeys(rendered)).toEqual([newer.key, older.key])
  })

  test("jobs a provider hands over with its runs are not fetched again", async () => {
    const run = makeRun({ provider: "buildkite", status: "running" })
    const jobs = new Map([[run.key, [makeJob(run.key, "running")]]])
    const provider = new FakeProvider("buildkite", [run], jobs, true)
    const { internals, rendered } = makeApp([provider])

    await internals.performRefresh()

    expect(provider.fetchJobsFor).toEqual([])
    expect(rendered.at(-1)?.jobs.get(run.key)).toHaveLength(1)
  })

  test("each run's actions go to the provider that reported it", async () => {
    const mine = makeRun({ provider: "github", id: "1" })
    const theirs = makeRun({ provider: "buildkite", id: "2" })
    const github = new FakeProvider("github", [mine])
    const buildkite = new FakeProvider("buildkite", [theirs])
    const { app } = makeApp([github, buildkite])

    const providerFor = (
      app as unknown as { providerFor(run: Run): CiProvider | undefined }
    ).providerFor.bind(app)

    expect(providerFor(mine)).toBe(github)
    expect(providerFor(theirs)).toBe(buildkite)
  })

  test("a provider's diagnostics reach the log pane", async () => {
    const provider = new FakeProvider("github", [], new Map(), false, [
      { provider: "github", level: "error", message: "GitHub: API rate limit exceeded" },
    ])
    const { internals, logs } = makeApp([provider])

    await internals.performRefresh()

    expect(logs).toContain("GitHub: API rate limit exceeded")
  })
})

describe("resurrect", () => {
  test("a rate-limited resurrect says so instead of claiming there is nothing older", async () => {
    const provider = new PagingProvider("github", [makeRun({ status: "running" })])
    provider.olderResult = {
      runs: [],
      diagnostics: [
        { provider: "github", level: "error", message: "GitHub: API rate limit exceeded" },
      ],
    }
    const { app, internals, logs } = makeApp([provider])

    await internals.performRefresh()
    await app.resurrectOldestRun()

    expect(logs).toContain("GitHub: API rate limit exceeded")
  })

  test("a provider that cannot page backwards simply sits it out", async () => {
    const provider = new FakeProvider("github", [makeRun({ status: "running" })])
    const { app, internals, logs } = makeApp([provider])

    await internals.performRefresh()
    await app.resurrectOldestRun()

    expect(logs).toContain("No older workflows found")
  })

  test("an older run comes back as a finished, dismissible card", async () => {
    const provider = new PagingProvider("github", [makeRun({ id: "2", status: "running" })])
    const old = makeRun({ id: "1", status: "passed", createdAt: "2026-09-16T10:00:00Z" })
    provider.olderResult = { runs: [old], diagnostics: [] }
    const { app, internals, rendered } = makeApp([provider])

    await internals.performRefresh()
    await app.resurrectOldestRun()

    expect(visibleKeys(rendered)).toContain(old.key)
    expect(internals.completedWorkflows.has(old.key)).toBe(true)
  })
})
