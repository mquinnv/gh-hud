import { exec } from 'child_process'
import { promisify } from 'util'
import { GitHubService } from './github.js'
import { ConfigManager } from './config.js'
import { Dashboard } from './dashboard.js'
import type { WorkflowRun, WorkflowJob } from './types.js'

const execAsync = promisify(exec)

export class App {
  private githubService: GitHubService
  private configManager: ConfigManager
  private dashboard: Dashboard
  private refreshInterval?: NodeJS.Timeout
  private repositories: string[] = []
  private jobs: Map<string, WorkflowJob[]> = new Map()
  private isRefreshing = false

  constructor() {
    this.githubService = new GitHubService()
    this.configManager = new ConfigManager()
    this.dashboard = new Dashboard()
  }

  async initialize(args: {
    config?: string
    repositories?: string[]
    organizations?: string[]
    interval?: number
  }): Promise<void> {
    // Load configuration
    await this.configManager.loadConfig(args.config)

    // Update config with command-line arguments
    if (args.repositories?.length) {
      this.configManager.updateFromArgs({ repositories: args.repositories })
    }
    if (args.organizations?.length) {
      this.configManager.updateFromArgs({ organizations: args.organizations })
    }
    if (args.interval) {
      this.configManager.updateFromArgs({ refreshInterval: args.interval * 1000 })
    }

    // Build repository list
    this.repositories = await this.configManager.buildRepositoryList(this.githubService)
    
    if (this.repositories.length === 0) {
      console.log('No repositories found to monitor. Please configure repositories or organizations.')
      process.exit(1)
    }

    console.log(`Monitoring ${this.repositories.length} repositories...`)
    
    // Set up event handlers
    this.setupEventHandlers()

    // Initial fetch
    await this.refresh()

    // Start auto-refresh
    this.startAutoRefresh()
  }

  private setupEventHandlers(): void {
    // Handle manual refresh
    this.dashboard.onRefresh(() => {
      this.refresh()
    })

    // Handle opening workflow in browser
    this.dashboard.onOpenWorkflow(async (workflow: WorkflowRun) => {
      try {
        const url = workflow.htmlUrl
        const platform = process.platform
        
        let command: string
        if (platform === 'darwin') {
          command = `open "${url}"`
        } else if (platform === 'win32') {
          command = `start "${url}"`
        } else {
          command = `xdg-open "${url}"`
        }
        
        await execAsync(command)
      } catch (error) {
        console.error('Failed to open workflow in browser:', error)
      }
    })
  }

  private async refresh(): Promise<void> {
    if (this.isRefreshing) return
    this.isRefreshing = true

    try {
      // Fetch all active workflows
      const workflows = await this.githubService.getAllActiveWorkflows(this.repositories)
      
      // Fetch jobs for active workflows
      const jobPromises = workflows
        .filter(w => w.status !== 'completed')
        .map(async (workflow) => {
          const repo = `${workflow.repository.owner}/${workflow.repository.name}`
          const jobs = await this.githubService.getWorkflowJobs(repo, workflow.id)
          return { id: workflow.id.toString(), jobs }
        })

      const jobResults = await Promise.all(jobPromises)
      
      // Update jobs map
      this.jobs.clear()
      jobResults.forEach(({ id, jobs }) => {
        this.jobs.set(id, jobs)
      })

      // Update dashboard
      this.dashboard.updateWorkflows(workflows, this.jobs)
    } catch (error) {
      console.error('Error refreshing workflows:', error)
    } finally {
      this.isRefreshing = false
    }
  }

  private startAutoRefresh(): void {
    const interval = this.configManager.refreshInterval
    this.refreshInterval = setInterval(() => {
      this.refresh()
    }, interval)
  }

  private stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = undefined
    }
  }

  stop(): void {
    this.stopAutoRefresh()
    this.dashboard.destroy()
  }
}
