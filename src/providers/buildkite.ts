import { fromBuildkiteJob } from "../status.js"
import type { Job, Run } from "../types.js"
import {
  type BuildkiteBuildPayload,
  type BuildkiteJobPayload,
  type BuildkitePipelinePayload,
  indexPipelinesByRepo,
  isDisplayableJob,
  mapBuildkiteBuild,
  mapBuildkiteJob,
} from "./buildkite-map.js"
import type { CiProvider, FetchResult, ProviderDiagnostic, Scope } from "./types.js"

const API = "https://api.buildkite.com/v2"
/** The token is only ever sent to this origin — never to a Link header or a
 * log_url that happens to point somewhere else. */
const API_ORIGIN = "https://api.buildkite.com/"

/** How often the pipeline index is refreshed — pipelines change far more slowly than builds. */
const PIPELINE_INDEX_TTL_MS = 5 * 60 * 1000

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface BuildkiteProviderOptions {
  token?: string
  /** Auto-detected when the token reaches exactly one organization. */
  org?: string
  /**
   * Explicit pipeline slugs. Non-empty wins over deriving slugs from
   * `Scope.repositories`, in both scoped and unscoped modes.
   */
  pipelines?: string[]
  /** Injectable so tests never touch the network. */
  fetch?: FetchLike
  /** Testing seam for the pipeline index TTL. Defaults to `Date.now`. */
  now?: () => number
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
  constructor(scope: "read" | "write" = "read") {
    super(
      scope === "write"
        ? "token rejected — check scopes (needs write_builds)"
        : "token rejected — check scopes (needs read_builds, read_pipelines)",
    )
  }
}

class AmbiguousOrganization extends Error {
  constructor(slugs: string[]) {
    super(`several orgs reachable (${slugs.join(", ")}) — set buildkite.org or --bk-org`)
  }
}

class NoOrganizations extends Error {
  constructor() {
    super("token reaches no organizations")
  }
}

/** A non-auth HTTP failure. `path` is the request path only — never the token. */
class HttpError extends Error {
  constructor(status: number, path: string) {
    super(`HTTP ${status} from ${path}`)
  }
}

/** Picks the job whose log actually explains a failure, not the pipeline upload. */
function pickLogJob(jobs: BuildkiteJobPayload[]): BuildkiteJobPayload | undefined {
  const failed = jobs.find((job) => {
    if (!job.log_url) return false
    const status = fromBuildkiteJob(job.state, job.soft_failed === true)
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
  private readonly now: () => number
  private readonly limit = 20

  private resolvedOrg?: string
  private pipelineIndex?: { index: Map<string, string[]>; timestamp: number }

  constructor(options: BuildkiteProviderOptions) {
    const trimmed = options.token?.trim()
    this.token = trimmed ? trimmed : undefined
    this.configuredOrg = options.org
    this.explicitPipelines = options.pipelines ?? []
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? Date.now
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

    const diagnostics: ProviderDiagnostic[] = []
    // A configured pipeline list wins over deriving slugs from the scope, in
    // both scoped and unscoped modes — it never touches the index.
    let slugs: string[] | undefined
    if (this.explicitPipelines.length > 0) {
      slugs = this.explicitPipelines
    } else if (scope.repositories.length > 0) {
      let index: Map<string, string[]>
      try {
        index = await this.getPipelineIndex(org)
      } catch (error) {
        return { runs: [], diagnostics: [this.diagnoseFetchError(error)] }
      }
      slugs = []
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
    }
    // Otherwise `slugs` stays undefined: unscoped, org-wide.

    const builds: BuildkiteBuildPayload[] = []
    if (slugs) {
      for (const slug of slugs) {
        try {
          builds.push(
            ...(await this.getPage<BuildkiteBuildPayload>(
              // `per_page` is a window of the N most recent builds, not
              // something to paginate through — one page, ever. Never
              // `exclude_jobs`: embedded jobs are how fetchRuns returns them
              // for free.
              `/organizations/${org}/pipelines/${slug}/builds?per_page=${this.limit}`,
            )),
          )
        } catch (error) {
          // Caught per slug so one bad pipeline doesn't hide the rest.
          diagnostics.push(this.diagnoseFetchError(error))
        }
      }
    } else {
      try {
        builds.push(
          ...(await this.getPage<BuildkiteBuildPayload>(
            `/organizations/${org}/builds?per_page=${this.limit}`,
          )),
        )
      } catch (error) {
        diagnostics.push(this.diagnoseFetchError(error))
      }
    }

    const runs: Run[] = []
    const jobs = new Map<string, Job[]>()
    for (const raw of builds) {
      try {
        const run = mapBuildkiteBuild(raw)
        const runJobs = raw.jobs
          .filter(isDisplayableJob)
          .map((job) => mapBuildkiteJob(job, run.key))
        runs.push(run)
        jobs.set(run.key, runJobs)
      } catch (error) {
        // A malformed build (e.g. missing `jobs`) is a diagnostic, not a
        // reason to fail the whole refresh.
        diagnostics.push(this.diagnoseFetchError(error))
      }
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
    const job = pickLogJob(build.jobs ?? [])
    if (!job?.log_url) return ""

    const response = await this.request(job.log_url)
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

    // Not cached on failure: a bad lookup must retry on the next refresh.
    const orgs = await this.getAll<{ slug: string }>("/organizations")
    if (orgs.length === 1) {
      this.resolvedOrg = orgs[0].slug
      return this.resolvedOrg
    }
    if (orgs.length === 0) throw new NoOrganizations()
    throw new AmbiguousOrganization(orgs.map((o) => o.slug))
  }

  private async getPipelineIndex(org: string): Promise<Map<string, string[]>> {
    const now = this.now()
    if (this.pipelineIndex && now - this.pipelineIndex.timestamp < PIPELINE_INDEX_TTL_MS) {
      return this.pipelineIndex.index
    }
    // Not cached on failure, same reasoning as resolveOrg.
    const pipelines = await this.getAll<BuildkitePipelinePayload>(
      `/organizations/${org}/pipelines?per_page=100`,
    )
    const index = indexPipelinesByRepo(pipelines)
    this.pipelineIndex = { index, timestamp: now }
    return index
  }

  /**
   * A paginating GET that follows `Link: rel="next"` across an array
   * response. Only for `/organizations` and the pipeline index — builds use
   * `getPage`, exactly once, regardless of any Link header they carry.
   */
  private async getAll<T>(path: string): Promise<T[]> {
    const out: T[] = []
    let url: string | undefined = path.startsWith("http") ? path : `${API}${path}`
    while (url) {
      const response = await this.request(url)
      out.push(...((await response.json()) as T[]))
      url = nextLink(response.headers.get("link"))
    }
    return out
  }

  /**
   * A single-page GET for an array response. Builds only: `per_page` is a
   * window of the N most recent builds, not something to exhaust by
   * following `Link: rel="next"` — that would walk the entire build history
   * every refresh.
   */
  private async getPage<T>(path: string): Promise<T[]> {
    const response = await this.request(`${API}${path}`)
    return (await response.json()) as T[]
  }

  /** A GET for a single-object response, e.g. one build. */
  private async getOne<T>(path: string): Promise<T> {
    const response = await this.request(`${API}${path}`)
    return (await response.json()) as T
  }

  private async write(path: string): Promise<void> {
    await this.request(`${API}${path}`, { method: "PUT" }, "write")
  }

  /**
   * The one place a request actually goes out. Refuses to send the token
   * anywhere but the Buildkite API — a `Link` header or a job's `log_url`
   * pointing elsewhere must not receive it.
   */
  private async request(
    url: string,
    init?: RequestInit,
    tokenScope: "read" | "write" = "read",
  ): Promise<Response> {
    if (!url.startsWith(API_ORIGIN)) {
      throw new Error(`refusing to send the token to an unexpected host: ${url}`)
    }
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${this.token}` },
    })
    if (response.status === 401 || response.status === 403) {
      throw new TokenRejected(tokenScope)
    }
    if (!response.ok) {
      const path = url.startsWith(API) ? url.slice(API.length) : url
      throw new HttpError(response.status, path)
    }
    return response
  }

  private diagnoseFetchError(error: unknown): ProviderDiagnostic {
    const message = error instanceof Error ? error.message : String(error)
    return { provider: "buildkite", level: "error", message: `Buildkite: ${message}` }
  }
}
