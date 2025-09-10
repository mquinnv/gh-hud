import { execa } from 'execa'
import type { WorkflowRun, WorkflowJob, Repository } from './types.js'

export class GitHubService {
  private cache: Map<string, { data: any; timestamp: number }> = new Map()
  private cacheTimeout = 5000 // 5 seconds

  async listRepositories(org?: string): Promise<Repository[]> {
    try {
      const args = ['repo', 'list', '--json', 'name,owner', '--limit', '100']
      if (org) {
        args.push('--org', org)
      }

      const { stdout } = await execa('gh', args)
      const repos = JSON.parse(stdout)
      
      return repos.map((repo: any) => ({
        owner: repo.owner.login,
        name: repo.name,
        fullName: `${repo.owner.login}/${repo.name}`
      }))
    } catch (error) {
      // Silently fail for now, could log to file if needed
      return []
    }
  }

  async listWorkflowRuns(repo: string, limit = 20): Promise<WorkflowRun[]> {
    const cacheKey = `runs:${repo}`
    const cached = this.getFromCache<WorkflowRun[]>(cacheKey)
    if (cached) return cached

    try {
      const { stdout } = await execa('gh', [
        'run',
        'list',
        '--repo',
        repo,
        '--limit',
        limit.toString(),
        '--json',
        'databaseId,name,headBranch,headSha,number,event,status,conclusion,workflowDatabaseId,workflowName,url,createdAt,updatedAt,startedAt'
      ])

      const runs = JSON.parse(stdout)
      const [owner, name] = repo.split('/')
      
      const workflowRuns: WorkflowRun[] = runs.map((run: any) => ({
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
        headCommit: undefined // gh run list doesn't provide commit info
      }))

      this.setCache(cacheKey, workflowRuns)
      return workflowRuns
    } catch (error) {
      // Silently fail for now, could log to file if needed
      return []
    }
  }

  async getWorkflowJobs(repo: string, runId: number): Promise<WorkflowJob[]> {
    const cacheKey = `jobs:${repo}:${runId}`
    const cached = this.getFromCache<WorkflowJob[]>(cacheKey)
    if (cached) return cached

    try {
      const { stdout } = await execa('gh', [
        'run',
        'view',
        runId.toString(),
        '--repo',
        repo,
        '--json',
        'jobs'
      ])

      const data = JSON.parse(stdout)
      const jobs: WorkflowJob[] = data.jobs || []
      
      this.setCache(cacheKey, jobs)
      return jobs
    } catch (error) {
      // Silently fail for now, could log to file if needed
      return []
    }
  }

  async watchWorkflowRun(repo: string, runId: number): Promise<string> {
    try {
      const { stdout } = await execa('gh', [
        'run',
        'view',
        runId.toString(),
        '--repo',
        repo,
        '--json',
        'status,conclusion,jobs'
      ])

      return stdout
    } catch (error) {
      // Silently fail for now, could log to file if needed
      return ''
    }
  }

  async getAllActiveWorkflows(repos: string[]): Promise<WorkflowRun[]> {
    const allRuns: WorkflowRun[] = []
    
    for (const repo of repos) {
      const runs = await this.listWorkflowRuns(repo)
      // Filter for active (non-completed) runs and recently completed ones
      const activeRuns = runs.filter(run => {
        if (run.status !== 'completed') return true
        
        // Show completed runs for the last 24 hours (for testing/demo purposes)
        const completedAt = new Date(run.updatedAt)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
        return completedAt > oneDayAgo
      })
      
      allRuns.push(...activeRuns)
    }

    // Sort by most recently updated
    return allRuns.sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
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

  private setCache(key: string, data: any): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    })
  }

  clearCache(): void {
    this.cache.clear()
  }
}
