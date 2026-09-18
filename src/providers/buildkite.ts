import { fromBuildkite } from "../status.js"
import type { Job, Run } from "../types.js"
import {
  type BuildkiteBuildPayload,
  type BuildkiteJobPayload,
  type BuildkitePipelinePayload,
  indexPipelinesByRepo,
  mapBuildkiteBuild,
  mapBuildkiteJob,
} from "./buildkite-map.js"
import type { CiProvider, FetchResult, ProviderDiagnostic, Scope } from "./types.js"

const API = "https://api.buildkite.com/v2"

/** How often the pipeline index is refreshed — pipelines change far more slowly than builds. */
const PIPELINE_INDEX_TTL_MS = 5 * 60 * 1000

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface BuildkiteProviderOptions {
  token?: string
  /** Auto-detected when the token reaches exactly one organization. */
  org?: string
  /** Explicit pipeline slugs to watch when `Scope.repositories` is empty. */
  pipelines?: string[]
  /** Injectable so tests never touch the network. */
  fetch?: FetchLike
}

export function resolveBuildkiteToken(
  env: Record<string, string | undefined>,
  config: { token?: string } | undefined,
): string | undefined {
  const fromEnv = env.BUILDKITE_API_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const fromConfig = config?.token?.trim()
  return fromConfig ? fromConfig : undefined
}

/** Extracts the rel="next" URL from an RFC 5988 Link header. */
export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return undefined
}

/** A token that is present but rejected by the API (401/403) — must be loud. */
export class TokenRejected extends Error {
  constructor() {
    super("Buildkite token rejected")
  }
}

class AmbiguousOrganization extends Error {
  constructor(readonly slugs: string[]) {
    super(`Ambiguous Buildkite organization: ${slugs.join(", ")}`)
  }
}

class NoOrganizations extends Error {
  constructor() {
    super("Buildkite token reaches no organizations")
  }
}

/** Picks the job whose log actually explains a failure, not the pipeline upload. */
function pickLogJob(jobs: BuildkiteJobPayload[]): BuildkiteJobPayload | undefined {
  const failed = jobs.find((job) => {
    if (!job.log_url) return false
    const status = fromBuildkite(job.state)
    return status === "failed" || status === "timed_out"
  })
  if (failed) return failed

  const withLog = jobs.filter((job) => job.log_url)
  return withLog.length > 0 ? withLog[withLog.length - 1] : undefined
}

export class BuildkiteProvider implements CiProvider {
  readonly name = "buildkite"

  private readonly token?: string
  private readonly configuredOrg?: string
  private readonly explicitPipelines: string[]
  private readonly fetchImpl: FetchLike
  private readonly limit = 20

  private resolvedOrg?: string
  private pipelineIndex?: { index: Map<string, string[]>; timestamp: number }

  constructor(options: BuildkiteProviderOptions) {
    const trimmed = options.token?.trim()
    this.token = trimmed ? trimmed : undefined
    this.configuredOrg = options.org
    this.explicitPipelines = options.pipelines ?? []
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
  }

  async fetchRuns(scope: Scope): Promise<FetchResult> {
    if (!this.token) {
      return {
        runs: [],
        diagnostics: [
          {
            provider: "buildkite",
            level: "info",
            message: "Buildkite: no token ($BUILDKITE_API_TOKEN or buildkite.token) — skipped",
          },
        ],
      }
    }

    let org: string
    try {
      org = await this.resolveOrg()
    } catch (error) {
      return { runs: [], diagnostics: [this.diagnoseFetchError(error)] }
    }

    let index: Map<string, string[]>
    try {
      index = await this.getPipelineIndex(org)
    } catch (error) {
      return { runs: [], diagnostics: [this.diagnoseFetchError(error)] }
    }

    const diagnostics: ProviderDiagnostic[] = []
    const scoped = scope.repositories.length > 0 || this.explicitPipelines.length > 0
    const slugs: string[] = []

    if (scope.repositories.length > 0) {
      for (const repo of scope.repositories) {
        const repoSlugs = index.get(repo)
        if (!repoSlugs || repoSlugs.length === 0) {
          diagnostics.push({
            provider: "buildkite",
            level: "info",
            message: `Buildkite: no pipeline in ${org} builds ${repo}`,
          })
          continue
        }
        slugs.push(...repoSlugs)
      }
    } else if (this.explicitPipelines.length > 0) {
      slugs.push(...this.explicitPipelines)
    }

    const builds: BuildkiteBuildPayload[] = []
    try {
      if (scoped) {
        for (const slug of slugs) {
          builds.push(
            ...(await this.getAll<BuildkiteBuildPayload>(
              // Never `exclude_jobs` — embedded jobs are how fetchRuns returns them for free.
              `/organizations/${org}/pipelines/${slug}/builds?per_page=${this.limit}`,
            )),
          )
        }
      } else {
        builds.push(
          ...(await this.getAll<BuildkiteBuildPayload>(
            `/organizations/${org}/builds?per_page=${this.limit}`,
          )),
        )
      }
    } catch (error) {
      diagnostics.push(this.diagnoseFetchError(error))
    }

    const runs: Run[] = []
    const jobs = new Map<string, Job[]>()
    for (const raw of builds) {
      const run = mapBuildkiteBuild(raw)
      runs.push(run)
      jobs.set(
        run.key,
        raw.jobs.map((job) => mapBuildkiteJob(job, run.key)),
      )
    }

    return { runs, jobs, diagnostics }
  }

  /** Jobs always arrive embedded in the build payload — fetchRuns already has them. */
  async fetchJobs(_run: Run): Promise<Job[]> {
    return []
  }

  async cancel(run: Run): Promise<void> {
    const slug = this.requireSlug(run)
    const org = await this.resolveOrg()
    // PUT is what the Buildkite REST reference documents (with a matching curl
    // example); unverified against the live API — no token is available here.
    await this.write(`/organizations/${org}/pipelines/${slug}/builds/${run.number}/cancel`)
  }

  async rerun(run: Run): Promise<void> {
    const slug = this.requireSlug(run)
    const org = await this.resolveOrg()
    // PUT per the REST reference, same caveat as cancel — unverified live.
    await this.write(`/organizations/${org}/pipelines/${slug}/builds/${run.number}/rebuild`)
  }

  async logs(run: Run): Promise<string> {
    const slug = this.requireSlug(run)
    const org = await this.resolveOrg()
    const build = await this.getOne<BuildkiteBuildPayload>(
      `/organizations/${org}/pipelines/${slug}/builds/${run.number}`,
    )
    const job = pickLogJob(build.jobs)
    if (!job?.log_url) return ""

    const response = await this.fetchImpl(job.log_url, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (response.status === 401 || response.status === 403) throw new TokenRejected()
    if (!response.ok) throw new Error(`Buildkite ${response.status}`)
    const payload = (await response.json()) as { content?: string }
    return payload.content ?? ""
  }

  private requireSlug(run: Run): string {
    if (!run.pipelineSlug) {
      throw new Error(`Buildkite: run ${run.key} has no pipeline slug`)
    }
    return run.pipelineSlug
  }

  private async resolveOrg(): Promise<string> {
    if (this.resolvedOrg) return this.resolvedOrg
    if (this.configuredOrg) {
      this.resolvedOrg = this.configuredOrg
      return this.resolvedOrg
    }

    const orgs = await this.getAll<{ slug: string }>("/organizations")
    if (orgs.length === 1) {
      this.resolvedOrg = orgs[0].slug
      return this.resolvedOrg
    }
    if (orgs.length === 0) throw new NoOrganizations()
    throw new AmbiguousOrganization(orgs.map((o) => o.slug))
  }

  private async getPipelineIndex(org: string): Promise<Map<string, string[]>> {
    const now = Date.now()
    if (this.pipelineIndex && now - this.pipelineIndex.timestamp < PIPELINE_INDEX_TTL_MS) {
      return this.pipelineIndex.index
    }
    const pipelines = await this.getAll<BuildkitePipelinePayload>(
      `/organizations/${org}/pipelines?per_page=100`,
    )
    const index = indexPipelinesByRepo(pipelines)
    this.pipelineIndex = { index, timestamp: now }
    return index
  }

  /** A paginating GET that follows `Link: rel="next"` across an array response. */
  private async getAll<T>(path: string): Promise<T[]> {
    const out: T[] = []
    let url: string | undefined = path.startsWith("http") ? path : `${API}${path}`
    while (url) {
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      })
      if (response.status === 401 || response.status === 403) throw new TokenRejected()
      if (!response.ok) throw new Error(`Buildkite ${response.status}`)
      out.push(...((await response.json()) as T[]))
      url = nextLink(response.headers.get("link"))
    }
    return out
  }

  /** A GET for a single-object response, e.g. one build. */
  private async getOne<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (response.status === 401 || response.status === 403) throw new TokenRejected()
    if (!response.ok) throw new Error(`Buildkite ${response.status}`)
    return (await response.json()) as T
  }

  private async write(path: string): Promise<void> {
    const response = await this.fetchImpl(`${API}${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (response.status === 401 || response.status === 403) throw new TokenRejected()
    if (!response.ok) throw new Error(`Buildkite ${response.status}`)
  }

  private diagnoseFetchError(error: unknown): ProviderDiagnostic {
    if (error instanceof TokenRejected) {
      return {
        provider: "buildkite",
        level: "error",
        message: "Buildkite: token rejected — check scopes (needs read_builds, read_pipelines)",
      }
    }
    if (error instanceof AmbiguousOrganization) {
      return {
        provider: "buildkite",
        level: "error",
        message: `Buildkite: several orgs reachable (${error.slugs.join(", ")}) — set buildkite.org or --bk-org`,
      }
    }
    if (error instanceof NoOrganizations) {
      return {
        provider: "buildkite",
        level: "error",
        message: "Buildkite: token reaches no organizations",
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { provider: "buildkite", level: "error", message: `Buildkite: ${message}` }
  }
}
