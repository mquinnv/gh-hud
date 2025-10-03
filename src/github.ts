import { execa } from "execa"
import type { PullRequest, Repository, WorkflowJob, WorkflowRun } from "./types.js"

export class GitHubService {
  private cache: Map<string, { data: unknown; timestamp: number }> = new Map()
  private cacheTimeout = 5000 // 5 seconds

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

  async listWorkflowRuns(repo: string, limit = 20, before?: string): Promise<WorkflowRun[]> {
    const cacheKey = `runs:${repo}`
    const cached = this.getFromCache<WorkflowRun[]>(cacheKey)
    if (cached) return cached

    try {
      const args = [
        "run",
        "list",
        "--repo",
        repo,
        "--limit",
        limit.toString(),
        "--json",
        "databaseId,name,headBranch,headSha,number,event,status,conclusion,workflowDatabaseId,workflowName,url,createdAt,updatedAt,startedAt",
      ]

      // Add created before filter for resurrect feature
      if (before) {
        args.push("--created", `<${before}`)
      }

      const { stdout } = await execa("gh", args, { timeout: 10000 })

      const runs = JSON.parse(stdout)
      const [owner, name] = repo.split("/")

      const workflowRuns: WorkflowRun[] = runs.map(
        (run: {
          databaseId?: number
          id?: number
          name?: string
          displayTitle?: string
          headBranch: string
          headSha: string
          number: number
          event: string
          status: string
          conclusion: string
          workflowDatabaseId: number
          workflowName: string
          url: string
          createdAt: string
          updatedAt: string
          startedAt: string
        }) => ({
          id: run.databaseId || run.id,
          name: run.name || run.displayTitle,
          headBranch: run.headBranch,
          headSha: run.headSha,
          runNumber: run.number,
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          workflowId: run.workflowDatabaseId,
          workflowName: run.workflowName,
          url: run.url,
          htmlUrl: run.url, // gh doesn't provide htmlUrl, use url
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          startedAt: run.startedAt,
          repository: { owner, name },
          headCommit: undefined, // gh run list doesn't provide commit info
        }),
      )

      this.setCache(cacheKey, workflowRuns)
      return workflowRuns
    } catch (error) {
      // Check if it's a rate limit error
      if (error instanceof Error && error.message?.includes("API rate limit exceeded")) {
        throw new Error("GitHub API rate limit exceeded. Please wait before trying again.")
      }
      // Silently fail for now, could log to file if needed
      return []
    }
  }

  async getWorkflowJobs(repo: string, runId: number): Promise<WorkflowJob[]> {
    const cacheKey = `jobs:${repo}:${runId}`
    const cached = this.getFromCache<WorkflowJob[]>(cacheKey)
    if (cached) return cached

    try {
      // Use the GitHub API directly to get runner information
      const { stdout } = await execa("gh", ["api", `repos/${repo}/actions/runs/${runId}/jobs`], {
        timeout: 10000,
      })

      const data = JSON.parse(stdout)
      const jobs: WorkflowJob[] = (data.jobs || []).map(
        (job: {
          id: number
          run_id: number
          workflow_name: string
          name: string
          status: string
          conclusion: string | null
          started_at: string | null
          completed_at: string | null
          runner_name?: string | null
          runner_id?: number | null
          runner_group_name?: string | null
          steps?: Array<{
            name: string
            status: string
            conclusion: string | null
            number: number
            started_at: string | null
            completed_at: string | null
          }>
        }) => ({
          id: job.id,
          runId: job.run_id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          startedAt: job.started_at,
          completedAt: job.completed_at,
          steps: job.steps,
          runnerName: job.runner_name,
          runnerId: job.runner_id,
          runnerGroupName: job.runner_group_name,
        }),
      )

      this.setCache(cacheKey, jobs)
      return jobs
    } catch (_error) {
      // Silently fail for now, could log to file if needed
      return []
    }
  }

  async watchWorkflowRun(repo: string, runId: number): Promise<string> {
    try {
      const { stdout } = await execa(
        "gh",
        ["run", "view", runId.toString(), "--repo", repo, "--json", "status,conclusion,jobs"],
        { timeout: 10000 },
      )

      return stdout
    } catch (_error) {
      // Silently fail for now, could log to file if needed
      return ""
    }
  }

  async getAllRecentWorkflows(repos: string[]): Promise<WorkflowRun[]> {
    const allRuns: WorkflowRun[] = []

    for (const repo of repos) {
      const runs = await this.listWorkflowRuns(repo)
      // Return all recent workflows, let the App class decide which ones to show
      allRuns.push(...runs)
    }

    // Sort by creation time (most recent first) for stable chronological ordering
    return allRuns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }

  async getOlderWorkflows(
    repos: string[],
    beforeTimestamp: string,
    limit = 1,
  ): Promise<WorkflowRun[]> {
    const allRuns: WorkflowRun[] = []

    for (const repo of repos) {
      const runs = await this.listWorkflowRuns(repo, limit, beforeTimestamp)
      allRuns.push(...runs)
    }

    // Sort by creation time and return only the most recent older workflows
    const sortedRuns = allRuns.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    return sortedRuns.slice(0, limit)
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
