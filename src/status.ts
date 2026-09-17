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
