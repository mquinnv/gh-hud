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
      "queued",
      "running",
      "blocked",
      "passed",
      "failed",
      "canceled",
      "skipped",
      "timed_out",
      "action_required",
    ] as const
    for (const s of all) {
      expect(statusIcon(s).length).toBeGreaterThan(0)
      expect(statusColor(s).length).toBeGreaterThan(0)
    }
  })
})
