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
