import { afterAll, describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { Job, Run, Step } from "./types.js"

// The Dashboard reads and writes ~/.gh-hud-prefs.json on construction and on
// destroy. Point HOME somewhere disposable before it is ever imported.
const originalHome = process.env.HOME
process.env.HOME = mkdtempSync(join(tmpdir(), "gh-hud-dashboard-test-"))

const { Dashboard } = await import("./dashboard.js")

// Give blessed a throwaway input/output pair instead of the real terminal.
// blessed still writes its enter/leave alternate-screen escape sequences,
// but they land in this PassThrough and are discarded, never in the test
// runner's own stdout — so the suite is safe to run without a TTY (this
// matters for `prepublishOnly`, which runs `bun test` during npm release).
const output = new PassThrough()
output.resume() // drain so blessed's writes never back up
const dashboard = new Dashboard({ input: new PassThrough(), output })

afterAll(() => {
  dashboard.destroy()
  if (originalHome) process.env.HOME = originalHome
})

/** The card renderer, which is private for every caller but this one. */
const card = (run: Run, jobs: Job[] = [], selected = false): string =>
  (
    dashboard as unknown as {
      formatWorkflowContent(run: Run, jobs: Job[], selected: boolean): string
    }
  ).formatWorkflowContent(run, jobs, selected)

function makeRun(partial: Partial<Run> = {}): Run {
  return {
    provider: "github",
    key: "github:acme/widgets:1",
    id: "1",
    number: 42,
    title: "fix: stop the widget exploding",
    pipeline: "CI",
    branch: "main",
    sha: "0123456789abcdef",
    status: "running",
    isFailing: false,
    repo: { owner: "acme", name: "widgets", fullName: "acme/widgets" },
    actor: "someone",
    event: "push",
    webUrl: "https://example.test/run",
    createdAt: "2026-09-17T10:00:00Z",
    startedAt: "2026-09-17T10:00:00Z",
    ...partial,
  }
}

function step(name: string, status: Step["status"], number: number): Step {
  return { name, status, number }
}

function makeJob(partial: Partial<Job> = {}): Job {
  return {
    id: "j1",
    key: "github:acme/widgets:1:j1",
    runKey: "github:acme/widgets:1",
    name: "build",
    status: "running",
    ...partial,
  }
}

describe("a run still in flight", () => {
  const run = makeRun({ status: "running" })

  test("leads with the commit title", () => {
    expect(card(run)).toContain(" fix: stop the widget exploding")
  })

  test("shows what triggered it, with the actor behind the event", () => {
    expect(card(run)).toContain("Triggered by: {magenta-fg}push{/magenta-fg}")
    expect(card(run)).toContain("by someone")
  })

  test("prints one status line and no duplicate verdict", () => {
    const content = card(run)
    expect(content).toContain("Status: {yellow-fg}● RUNNING{/}")
    expect(content).not.toContain("Result:")
  })

  test("counts time against now, and does not offer dismissal", () => {
    const content = card(run)
    expect(content).toContain("Running: {white-fg}")
    expect(content).not.toContain("Duration:")
    expect(content).not.toContain("Press 'd' to dismiss")
  })

  test("shows step progress for the running job", () => {
    const job = makeJob({
      status: "running",
      steps: [step("checkout", "passed", 1), step("test", "running", 2), step("ship", "queued", 3)],
    })

    const content = card(run, [job])
    expect(content).toContain("Progress: {cyan-fg}1/3 steps{/cyan-fg}")
    expect(content).toContain("▶ 2/3 test")
    expect(content).toContain("○ 3/3 ship")
  })
})

describe("a run that is going to fail", () => {
  // Buildkite reports this directly; for GitHub applyIsFailing derives it. The
  // card has to make "running, but doomed" look different from "running".
  const run = makeRun({ status: "running", isFailing: true })

  test("turns the running marker red", () => {
    expect(card(run)).toContain("Status: {red-fg}◉ RUNNING{/}")
  })

  test("still offers no dismissal — it has not finished", () => {
    expect(card(run)).not.toContain("Press 'd' to dismiss")
  })
})

describe("a finished run", () => {
  const run = makeRun({
    status: "failed",
    startedAt: "2026-09-17T10:00:00Z",
    finishedAt: "2026-09-17T10:02:30Z",
  })

  test("shows the verdict once", () => {
    const content = card(run)
    expect(content).toContain("Status: {red-fg}✗ FAILED{/}")
    expect(content).not.toContain("Result:")
  })

  test("shows how long it took, not how long ago it started", () => {
    const content = card(run)
    expect(content).toContain("Duration: {white-fg}2m 30s{/white-fg}")
    expect(content).not.toContain("Running:")
  })

  test("offers dismissal", () => {
    expect(card(run)).toContain("Press 'd' to dismiss")
  })

  test("names the step that failed", () => {
    const job = makeJob({
      status: "failed",
      steps: [step("checkout", "passed", 1), step("test", "failed", 2)],
    })

    expect(card(run, [job])).toContain("✗ Failed at: test")
  })
})

describe("jobs with no steps", () => {
  const run = makeRun({ status: "blocked" })

  test("a manual job waiting on a human says so", () => {
    const job = makeJob({ name: "deploy", status: "blocked", type: "manual" })
    expect(card(run, [job])).toContain("waiting for unblock")
  })

  test("a command job shows its command", () => {
    const job = makeJob({ status: "running", command: "bun run deploy" })
    expect(card(run, [job])).toContain("bun run deploy")
  })

  test("a blocked run is paused, not running or finished", () => {
    const content = card(run)
    expect(content).toContain("Status: {cyan-fg}⏸ BLOCKED{/}")
    expect(content).not.toContain("Press 'd' to dismiss")
  })
})

// The grid, whose boxes carry the empty-state instructions or the run cards —
// whichever `layoutWorkflows` most recently built.
const gridBoxes = (): Array<{ getContent(): string }> =>
  (dashboard as unknown as { grid: Array<{ getContent(): string }> }).grid

describe("empty-state diagnostics", () => {
  // A Buildkite misconfiguration on a checkout with no GitHub Actions runs
  // must not look like idle CI — the empty state has to say why each
  // provider contributed nothing.
  test("a diagnostic renders in the empty state when the grid has no cards", () => {
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [
      {
        provider: "buildkite",
        level: "info",
        message: "Buildkite: no token ($BUILDKITE_API_TOKEN or buildkite.token) — skipped",
      },
    ])

    const content = gridBoxes()[0]?.getContent() ?? ""
    expect(content).toContain(
      "Buildkite: no token ($BUILDKITE_API_TOKEN or buildkite.token) — skipped",
    )
  })

  test("error-level diagnostics are visually distinct from info-level ones", () => {
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [
      { provider: "buildkite", level: "info", message: "an info diagnostic" },
      { provider: "buildkite", level: "error", message: "a rejected-token diagnostic" },
    ])

    // blessed (tags: true) parses `{red-fg}`/`{white-fg}` into their SGR
    // escape codes by the time getContent() returns them, so the tag
    // survives only as that distinct color code around each message.
    const content = gridBoxes()[0]?.getContent() ?? ""
    const esc = String.fromCharCode(27)
    const colorBefore = (message: string): string | undefined =>
      content.slice(0, content.indexOf(message)).match(new RegExp(`${esc}\\[(\\d+)m$`))?.[1]

    const infoColor = colorBefore("an info diagnostic")
    const errorColor = colorBefore("a rejected-token diagnostic")
    expect(infoColor).toBeDefined()
    expect(errorColor).toBeDefined()
    expect(errorColor).not.toBe(infoColor)
    expect(errorColor).toBe("31") // red — matches the event log's error color
  })

  test("diagnostics disappear from the empty state once the grid is truly empty of them", () => {
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [])

    const content = gridBoxes()[0]?.getContent() ?? ""
    expect(content).not.toContain("diagnostic")
  })

  test("diagnostics are not shown once the grid has cards", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      { provider: "buildkite", level: "error", message: "should never render on a card" },
    ])

    const content = gridBoxes()
      .map((box) => box.getContent())
      .join("\n")
    expect(content).not.toContain("should never render on a card")

    // Leave the dashboard back in its empty, diagnostic-free starting state
    // for any test that runs after this one in the shared instance.
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [])
  })
})

// The persistent status-bar warning (Ruling 29): with real, healthy cards on
// screen — e.g. GitHub runs from phenixcrm/* — a Buildkite provider that is
// loudly failing on inetalliance/* must not be reduced to one line in the
// scrolling event log. Only error-level diagnostics ever reach here; a
// missing-token info diagnostic must stay silent for accounts with no
// Buildkite at all.
const statusBarContent = (): string =>
  (dashboard as unknown as { statusBox: { getContent(): string } }).statusBox.getContent()

describe("status-bar error diagnostics", () => {
  test("an error diagnostic appears in the status bar alongside existing cards", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      {
        provider: "buildkite",
        level: "error",
        message: "Buildkite: token rejected — check scopes",
      },
    ])

    expect(statusBarContent()).toContain("Buildkite: token rejected — check scopes")
  })

  test("an info diagnostic never appears in the status bar", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      {
        provider: "buildkite",
        level: "info",
        message: "Buildkite: no token ($BUILDKITE_API_TOKEN or buildkite.token) — skipped",
      },
    ])

    expect(statusBarContent()).not.toContain("Buildkite: no token")
  })

  test("the indicator disappears once a refresh no longer reports the error", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      { provider: "buildkite", level: "error", message: "Buildkite: token rejected" },
    ])
    expect(statusBarContent()).toContain("token rejected")

    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [])
    expect(statusBarContent()).not.toContain("token rejected")
  })

  test("several errors show the first message plus a count of the rest", () => {
    const run = makeRun({ status: "running" })
    dashboard.updateWorkflows([run], new Map(), undefined, undefined, [
      { provider: "buildkite", level: "error", message: "first error" },
      { provider: "github", level: "error", message: "second error" },
      { provider: "github", level: "error", message: "third error" },
    ])

    const content = statusBarContent()
    expect(content).toContain("first error")
    expect(content).toContain("+2 more")
    expect(content).not.toContain("second error")

    // Leave the shared dashboard back in its diagnostic-free starting state.
    dashboard.updateWorkflows([], new Map(), undefined, undefined, [])
  })
})
