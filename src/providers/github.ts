import { execa } from "execa"
import type { Job, PullRequest, Repository, Run } from "../types.js"
import {
  type GitHubJobPayload,
  type GitHubRunPayload,
  mapGitHubJob,
  mapGitHubRun,
} from "./github-map.js"
import type { CiProvider, FetchResult, ProviderDiagnostic, Scope } from "./types.js"

export class GitHubProvider implements CiProvider {
  readonly name = "github"

  private cache: Map<string, { data: unknown; timestamp: number }> = new Map()
  private cacheTimeout = 5000 // 5 seconds
  private limit = 20

  async listRepositories(org?: string): Promise<Repository[]> {
    try {
      const args = ["repo", "list", "--json", "name,owner", "--limit", "100"]
      if (org) {
        args.push(org)
      }

      const { stdout } = await execa("gh", args, { timeout: 10000 })
      const repos = JSON.parse(stdout)

      return repos.map((repo: { owner: { login: string }; name: string }) => ({
        owner: repo.owner.login,
        name: repo.name,
        fullName: `${repo.owner.login}/${repo.name}`,
      }))
    } catch (error) {
      // Check if it's a rate limit error
      if (error instanceof Error && error.message?.includes("API rate limit exceeded")) {
        throw new Error("GitHub API rate limit exceeded. Please wait before trying again.")
      }
      // Silently fail for now, could log to file if needed
      return []
    }
  }

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

  async fetchJobs(run: Run): Promise<Job[]> {
    const repo = run.repo.fullName
    const cacheKey = `jobs:${repo}:${run.id}`
    const cached = this.getFromCache<Job[]>(cacheKey)
    if (cached) return cached

    try {
      // The API, not `gh run view`, because only the API reports the runner.
      const { stdout } = await execa("gh", ["api", `repos/${repo}/actions/runs/${run.id}/jobs`], {
        timeout: 10000,
      })

      const payload = JSON.parse(stdout) as { jobs?: GitHubJobPayload[] }
      const jobs = (payload.jobs ?? []).map((raw) => mapGitHubJob(raw, run.key))

      this.setCache(cacheKey, jobs)
      return jobs
    } catch (_error) {
      // Silently fail for now, could log to file if needed
      return []
    }
  }

  async cancel(run: Run): Promise<void> {
    await execa("gh", ["run", "cancel", run.id, "-R", run.repo.fullName], { timeout: 10000 })
  }

  async rerun(run: Run): Promise<void> {
    await execa("gh", ["run", "rerun", run.id, "-R", run.repo.fullName], { timeout: 10000 })
  }

  async logs(run: Run): Promise<string> {
    const { stdout } = await execa(
      "gh",
      ["run", "view", run.id, "-R", run.repo.fullName, "--log"],
      {
        timeout: 30000,
      },
    )
    return stdout
  }

  /**
   * Runs older than `before`, for the resurrect key. Deliberately uncached:
   * the cache is keyed by repository, and a page of older runs must not
   * displace the page of current ones the grid is built from.
   */
  async fetchOlderRuns(repos: string[], before: string, limit = 1): Promise<Run[]> {
    const runs: Run[] = []

    for (const repo of repos) {
      try {
        const created = encodeURIComponent(`<${before}`)
        const { stdout } = await execa(
          "gh",
          ["api", `repos/${repo}/actions/runs?per_page=${limit}&created=${created}`],
          { timeout: 10000 },
        )
        const payload = JSON.parse(stdout) as { workflow_runs: GitHubRunPayload[] }
        runs.push(...(payload.workflow_runs ?? []).map(mapGitHubRun))
      } catch (_error) {
        // Skip repositories we can't read; the others still contribute.
      }
    }

    runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return runs.slice(0, limit)
  }

  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key)
    if (!cached) return null

    const now = Date.now()
    if (now - cached.timestamp > this.cacheTimeout) {
      this.cache.delete(key)
      return null
    }

    return cached.data as T
  }

  private setCache(key: string, data: unknown): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    })
  }

  clearCache(): void {
    this.cache.clear()
  }

  async listPullRequests(repo: string, limit = 20): Promise<PullRequest[]> {
    const cacheKey = `prs:${repo}`
    const cached = this.getFromCache<PullRequest[]>(cacheKey)
    if (cached) return cached

    try {
      const { stdout } = await execa(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--limit",
          limit.toString(),
          "--json",
          "id,number,title,state,isDraft,headRefName,baseRefName,url,createdAt,updatedAt,author,statusCheckRollup,reviewDecision,mergeable",
        ],
        { timeout: 10000 },
      )

      const prs = JSON.parse(stdout)
      const [owner, name] = repo.split("/")

      const pullRequests: PullRequest[] = prs.map(
        (pr: {
          id: string
          number: number
          title: string
          state?: string
          isDraft?: boolean
          headRefName: string
          baseRefName: string
          url: string
          createdAt: string
          updatedAt: string
          author?: { login: string }
          statusCheckRollup?: { state: string }
          reviewDecision?: string
          mergeable?: string
        }) => ({
          id: pr.id,
          number: pr.number,
          title: pr.title,
          state: pr.state?.toLowerCase() || "open",
          draft: pr.isDraft || false,
          user: {
            login: pr.author?.login || "unknown",
          },
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          url: pr.url,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          repository: { owner, name },
          statusCheckRollup: pr.statusCheckRollup
            ? { state: pr.statusCheckRollup.state }
            : undefined,
          reviewDecision: pr.reviewDecision,
          mergeable: pr.mergeable,
          isDraft: pr.isDraft,
        }),
      )

      this.setCache(cacheKey, pullRequests)
      return pullRequests
    } catch (error) {
      // Check if it's a rate limit error
      if (error instanceof Error && error.message?.includes("API rate limit exceeded")) {
        throw new Error("GitHub API rate limit exceeded. Please wait before trying again.")
      }
      // Return empty array on error (silently fail)
      return []
    }
  }

  async getAllPullRequests(repos: string[]): Promise<PullRequest[]> {
    const allPRs: PullRequest[] = []

    for (const repo of repos) {
      const prs = await this.listPullRequests(repo)
      allPRs.push(...prs)
    }

    // Sort by creation time (most recent first) for stable chronological ordering
    return allPRs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }
}
