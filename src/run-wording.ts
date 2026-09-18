// Provider-accurate wording for a run and its actions. GitHub Actions calls
// one of these a "workflow run" and re-triggering it a "rerun"; Buildkite
// calls the same concepts a "build" and a "rebuild". The UI must always use
// the term the run's own provider uses, so that wording lives here once
// instead of being re-decided inline at every call site.

import type { Run } from "./types.js"

/** The noun for one of this run's provider's runs. */
export function runNoun(run: Run): string {
  return run.provider === "buildkite" ? "build" : "workflow run"
}

/** The verb for re-triggering one of this run's provider's runs. */
export function rerunVerb(run: Run): string {
  return run.provider === "buildkite" ? "rebuild" : "rerun"
}
