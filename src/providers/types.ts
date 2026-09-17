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
