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
  private watchedWorkflows: Set<number> = new Set() // Track workflows we've been watching
  private completedWorkflows: Map<number, WorkflowRun> = new Map() // Keep completed workflows until dismissed

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
      // Will show empty state in UI
      this.repositories = []
    }
    
    // Set up event handlers
    this.setupEventHandlers()

    // Initial fetch
    await this.performRefresh(false)

    // Start auto-refresh
    this.startAutoRefresh()
  }

  private setupEventHandlers(): void {
    // Handle manual refresh - but make sure it's only called explicitly
    this.dashboard.onRefresh(() => {
      this.performRefresh(true)
    })

    // Handle application exit
    this.dashboard.onExit(() => {
      this.stop()
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
        // Silently fail
      }
    })

    // Handle dismissing completed workflows
    this.dashboard.onDismissWorkflow((workflow: WorkflowRun) => {
      this.dismissCompletedWorkflow(workflow.id)
    })
  }

  private async performRefresh(_isManual: boolean = false): Promise<void> {
    if (this.isRefreshing) return
    this.isRefreshing = true

    // Show loading in status bar instead of blocking dialog
    this.dashboard.showLoadingInStatus()

    try {
      // Fetch all recent workflows
      const allRuns = await this.githubService.getAllRecentWorkflows(this.repositories)

      // Update watched and completed trackers
      for (const run of allRuns) {
        if (run.status !== 'completed') {
          this.watchedWorkflows.add(run.id)
        } else if (this.watchedWorkflows.has(run.id) && !this.completedWorkflows.has(run.id)) {
          // Transitioned to completed while being watched
          this.completedWorkflows.set(run.id, run)
        }
      }

      // Visible workflows = active runs + completed pending confirmation, excluding dismissed
      const workflows = allRuns.filter(run => {
        if (run.status !== 'completed') return true
        return this.completedWorkflows.has(run.id)
      })
      
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
      // Show error in dashboard if first load fails  
      console.error('Error in refresh():', error)
      this.dashboard.showError(`Failed to load workflows: ${error}`)
    } finally {
      this.isRefreshing = false
    }
  }

  private startAutoRefresh(): void {
    const interval = this.configManager.refreshInterval
    this.refreshInterval = setInterval(() => {
      // Auto-refresh (don't call through manual refresh handler)
      this.performRefresh(false)
    }, interval)
  }

  private stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = undefined
    }
  }

  private dismissCompletedWorkflow(workflowId: number): void {
    this.completedWorkflows.delete(workflowId)
    this.watchedWorkflows.delete(workflowId)
    // Trigger a refresh to update the display
    this.performRefresh(false)
  }

  stop(): void {
    this.stopAutoRefresh()
    this.dashboard.destroy()
  }
}
