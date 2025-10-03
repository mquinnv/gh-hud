import { exec } from "child_process"
import { promisify } from "util"
import { ConfigManager } from "./config.js"
import { Dashboard } from "./dashboard.js"
import { DockerServiceManager } from "./docker-utils.js"
import { GitHubService } from "./github.js"
import type { DockerServiceStatus, PullRequest, WorkflowJob, WorkflowRun } from "./types.js"

const execAsync = promisify(exec)

export class App {
  private githubService: GitHubService
  private dockerService: DockerServiceManager
  private configManager: ConfigManager
  private dashboard: Dashboard
  private refreshInterval?: NodeJS.Timeout
  private repositories: string[] = []
  private jobs: Map<string, WorkflowJob[]> = new Map()
  private isRefreshing = false
  private watchedWorkflows: Set<number> = new Set() // Track workflows we've been watching
  private completedWorkflows: Map<number, WorkflowRun> = new Map() // Keep completed workflows until dismissed
  private showPRs = false
  private pullRequests: PullRequest[] = []
  private showDocker = false
  private dockerServices: DockerServiceStatus[] = []
  private oldestWorkflowTimestamp?: string // Track the oldest workflow timestamp for resurrect feature

  constructor() {
    this.githubService = new GitHubService()
    this.dockerService = new DockerServiceManager()
    this.configManager = new ConfigManager()
    this.dashboard = new Dashboard()
  }

  async initialize(args: {
    config?: string
    repositories?: string[]
    organizations?: string[]
    interval?: number
    showPRs?: boolean
    showDocker?: boolean
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

    // Store the showPRs and showDocker flags
    this.showPRs = args.showPRs || false
    this.showDocker = args.showDocker || false

    // Build repository list
    this.repositories = await this.configManager.buildRepositoryList(
      this.githubService,
      this.dashboard,
    )

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
        if (platform === "darwin") {
          command = `open "${url}"`
        } else if (platform === "win32") {
          command = `start "${url}"`
        } else {
          command = `xdg-open "${url}"`
        }

        await execAsync(command)
      } catch (_error) {
        // Silently fail
      }
    })

    // Handle opening PR in browser
    this.dashboard.onOpenPR(async (pr: PullRequest) => {
      try {
        const url = pr.url
        const platform = process.platform

        let command: string
        if (platform === "darwin") {
          command = `open "${url}"`
        } else if (platform === "win32") {
          command = `start "${url}"`
        } else {
          command = `xdg-open "${url}"`
        }

        await execAsync(command)
        this.dashboard.log(`Opened PR #${pr.number}: ${pr.title}`, "info")
      } catch (_error) {
        // Silently fail
      }
    })

    // Handle dismissing completed workflows
    this.dashboard.onDismissWorkflow((workflow: WorkflowRun) => {
      this.dismissCompletedWorkflow(workflow.id)
    })

    // Handle dismissing all completed workflows
    this.dashboard.onDismissAllCompleted((workflows: WorkflowRun[]) => {
      this.dismissAllCompletedWorkflows(workflows)
    })

    // Handle resurrect older workflow
    this.dashboard.onResurrectWorkflow(() => {
      this.resurrectOldestWorkflow()
    })

    // Handle killing/cancelling workflow
    this.dashboard.onKillWorkflow(async (workflow: WorkflowRun) => {
      try {
        const repoName = `${workflow.repository.owner}/${workflow.repository.name}`
        this.dashboard.log(`Cancelling workflow run ${workflow.id} in ${repoName}...`, "info")

        // Execute gh command to cancel the workflow
        const command = `gh run cancel ${workflow.id} -R ${repoName}`
        await execAsync(command)

        this.dashboard.log(`Successfully cancelled workflow run ${workflow.id}`, "info")
        // Force refresh to update the status
        await this.performRefresh(true)
      } catch (error) {
        this.dashboard.log(`Failed to cancel workflow: ${error}`, "error")
      }
    })

    // Handle Docker service actions
    this.dashboard.onDockerAction(
      async (
        action: string,
        dockerService: {
          service: { name: string; state: string }
          repo: string
          composeFile?: string
          isProject?: boolean
        },
      ) => {
        try {
          const serviceName = dockerService.service.name
          const repo = dockerService.repo
          const composeFile = dockerService.composeFile

          // Use compose file path if available, otherwise fall back to repo lookup
          let repoPath = ""
          if (composeFile) {
            // Extract directory from compose file path
            const pathParts = composeFile.split("/")
            pathParts.pop() // Remove filename
            repoPath = pathParts.join("/")
          } else {
            // Fallback to old method
            const repository = this.repositories.find((r) => r.includes(repo))
            if (!repository) {
              this.dashboard.log(`Could not find repository path for ${repo}`, "error")
              return
            }
            repoPath = repository.startsWith("/") ? repository : process.cwd()
          }

          let command = ""

          switch (action) {
            case "start":
              this.dashboard.log(`Starting Docker service ${serviceName} in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose start ${serviceName}`
              break
            case "stop":
              this.dashboard.log(`Stopping Docker service ${serviceName} in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose stop ${serviceName}`
              break
            case "restart":
              this.dashboard.log(`Restarting Docker service ${serviceName} in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose restart ${serviceName}`
              break
            case "recreate":
              this.dashboard.log(`Recreating Docker service ${serviceName} in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose up -d --force-recreate ${serviceName}`
              break
            case "logs": {
              this.dashboard.log(
                `Showing logs for Docker service ${serviceName} in ${repo}...`,
                "info",
              )
              // For logs, we might want to show them in a box or open a new terminal
              command = `cd ${repoPath} && docker compose logs --tail=50 ${serviceName}`
              const { stdout } = await execAsync(command)
              this.dashboard.log(stdout, "info")
              return // Don't refresh for logs
            }
            case "shell":
              this.dashboard.log(
                `Opening shell for Docker service ${serviceName} in ${repo}...`,
                "info",
              )
              // This is tricky - might need to spawn a new terminal or pause blessed
              command = `cd ${repoPath} && docker compose exec ${serviceName} sh`
              this.dashboard.log(`Run manually: ${command}`, "info")
              return // Can't easily do interactive shell
            case "up":
              this.dashboard.log(`Starting all services in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose up -d`
              break
            case "start-all":
              this.dashboard.log(`Starting all services in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose start`
              break
            case "stop-all":
              this.dashboard.log(`Stopping all services in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose stop`
              break
            case "down":
              this.dashboard.log(`Taking down all services in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose down`
              break
            case "logs-all": {
              this.dashboard.log(`Showing logs for all services in ${repo}...`, "info")
              command = `cd ${repoPath} && docker compose logs --tail=50`
              const { stdout } = await execAsync(command)
              this.dashboard.log(stdout, "info")
              return // Don't refresh for logs
            }
            default:
              this.dashboard.log(`Unknown Docker action: ${action}`, "error")
              return
          }

          await execAsync(command)
          const target = dockerService.isProject ? `project ${repo}` : `service ${serviceName}`
          this.dashboard.log(`Successfully completed ${action} on ${target}`, "info")

          // Force refresh to update the status
          await this.performRefresh(true)
        } catch (error) {
          this.dashboard.log(`Failed to ${action} Docker service: ${error}`, "error")
        }
      },
    )

    // Handle PR merge
    this.dashboard.onPRMerge(async (pr: PullRequest, method: string) => {
      try {
        const repoName = `${pr.repository.owner}/${pr.repository.name}`
        this.dashboard.log(`Merging PR #${pr.number} using ${method} method...`, "info")

        const command = `gh pr merge ${pr.number} -R ${repoName} --${method}`
        await execAsync(command)

        this.dashboard.log(`Successfully merged PR #${pr.number}`, "info")
        await this.performRefresh(true)
      } catch (error) {
        this.dashboard.log(`Failed to merge PR: ${error}`, "error")
      }
    })

    // Handle PR checkout
    this.dashboard.onPRCheckout(async (pr: PullRequest) => {
      try {
        const repoName = `${pr.repository.owner}/${pr.repository.name}`
        this.dashboard.log(`Checking out PR #${pr.number} branch ${pr.headRefName}...`, "info")

        const command = `gh pr checkout ${pr.number} -R ${repoName}`
        await execAsync(command)

        this.dashboard.log(`Successfully checked out PR #${pr.number}`, "info")
      } catch (error) {
        this.dashboard.log(`Failed to checkout PR: ${error}`, "error")
      }
    })

    // Handle PR actions (draft/ready)
    this.dashboard.onPRAction(async (action: string, pr: PullRequest) => {
      try {
        const repoName = `${pr.repository.owner}/${pr.repository.name}`

        if (action === "ready") {
          this.dashboard.log(`Marking PR #${pr.number} as ready for review...`, "info")
          const command = `gh pr ready ${pr.number} -R ${repoName}`
          await execAsync(command)
          this.dashboard.log(`Successfully marked PR #${pr.number} as ready`, "info")
        } else if (action === "draft") {
          this.dashboard.log(`Converting PR #${pr.number} to draft...`, "info")
          const command = `gh pr edit ${pr.number} -R ${repoName} --draft`
          await execAsync(command)
          this.dashboard.log(`Successfully converted PR #${pr.number} to draft`, "info")
        }

        await this.performRefresh(true)
      } catch (error) {
        this.dashboard.log(`Failed to ${action} PR: ${error}`, "error")
      }
    })

    // Handle workflow rerun
    this.dashboard.onWorkflowRerun(async (workflow: WorkflowRun) => {
      try {
        const repoName = `${workflow.repository.owner}/${workflow.repository.name}`
        this.dashboard.log(`Re-running workflow ${workflow.id} in ${repoName}...`, "info")

        const command = `gh run rerun ${workflow.id} -R ${repoName}`
        await execAsync(command)

        this.dashboard.log(`Successfully triggered rerun of workflow ${workflow.id}`, "info")
        await this.performRefresh(true)
      } catch (error) {
        this.dashboard.log(`Failed to rerun workflow: ${error}`, "error")
      }
    })

    // Handle workflow logs
    this.dashboard.onWorkflowLogs(async (workflow: WorkflowRun) => {
      try {
        const repoName = `${workflow.repository.owner}/${workflow.repository.name}`
        this.dashboard.log(`Fetching logs for workflow ${workflow.id}...`, "info")

        const command = `gh run view ${workflow.id} -R ${repoName} --log`
        const { stdout } = await execAsync(command)

        // Show first 20 lines of logs in the dashboard
        const logLines = stdout.split("\n").slice(0, 20)
        logLines.forEach((line) => {
          this.dashboard.log(line, "info")
        })

        if (stdout.split("\n").length > 20) {
          this.dashboard.log(
            `... (truncated, run 'gh run view ${workflow.id} -R ${repoName} --log' for full logs)`,
            "info",
          )
        }
      } catch (error) {
        this.dashboard.log(`Failed to fetch workflow logs: ${error}`, "error")
      }
    })
  }

  private async performRefresh(_isManual: boolean = false): Promise<void> {
    // Don't refresh if a modal is open
    if (this.dashboard.isModalOpen()) return

    if (this.isRefreshing) return
    this.isRefreshing = true

    // Show loading in status bar instead of blocking dialog
    this.dashboard.showLoadingInStatus()

    try {
      // Fetch all recent workflows
      const allRuns = await this.githubService.getAllRecentWorkflows(this.repositories)

      // Fetch PRs if requested
      if (this.showPRs) {
        this.pullRequests = await this.githubService.getAllPullRequests(this.repositories)
      }

      // Fetch Docker services if requested
      if (this.showDocker) {
        this.dashboard.log(
          `Checking Docker services for repositories: ${this.repositories.join(", ")}`,
          "debug",
        )
        this.dockerServices = await this.dockerService.getAllDockerStatus(
          this.repositories,
          (msg) => this.dashboard.log(msg, "debug"),
        )
        const totalServices = this.dockerServices.reduce((acc, ds) => acc + ds.services.length, 0)
        const logLevel = this.dockerServices.length > 0 ? "info" : "debug"
        this.dashboard.log(
          `Found ${this.dockerServices.length} compose files, ${totalServices} total services`,
          logLevel,
        )

        // Log which repos have Docker services
        if (this.dockerServices.length > 0) {
          const reposWithDocker = [...new Set(this.dockerServices.map((ds) => ds.repository))]
          this.dashboard.log(`Docker services found in: ${reposWithDocker.join(", ")}`, "debug")
        }
      }

      // Update watched and completed trackers
      for (const run of allRuns) {
        if (run.status !== "completed") {
          this.watchedWorkflows.add(run.id)
        } else if (this.watchedWorkflows.has(run.id) && !this.completedWorkflows.has(run.id)) {
          // Transitioned to completed while being watched
          this.completedWorkflows.set(run.id, run)
        }
      }

      // Track the oldest workflow timestamp for resurrect feature
      if (allRuns.length > 0) {
        const oldestRun = allRuns[allRuns.length - 1]
        this.oldestWorkflowTimestamp = oldestRun.createdAt
      }

      // Visible workflows = active runs + completed pending confirmation, excluding dismissed
      const workflows = allRuns.filter((run) => {
        if (run.status !== "completed") return true
        return this.completedWorkflows.has(run.id)
      })

      // Fetch jobs for active workflows
      const jobPromises = workflows
        .filter((w) => w.status !== "completed")
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
      this.dashboard.updateWorkflows(workflows, this.jobs, this.pullRequests, this.dockerServices)
    } catch (error) {
      // Show error in dashboard
      this.dashboard.log(`Error refreshing: ${error}`, "error")
      this.dashboard.showError(`Failed to load workflows: ${error}`)
    } finally {
      this.isRefreshing = false
      // Stop the refresh animation
      this.dashboard.stopRefreshAnimation()
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
    // Update display immediately without API refresh
    this.updateDisplayAfterDismiss()
  }

  private dismissAllCompletedWorkflows(workflows: WorkflowRun[]): void {
    // Remove all completed workflows from tracking
    workflows.forEach((workflow) => {
      this.completedWorkflows.delete(workflow.id)
      this.watchedWorkflows.delete(workflow.id)
    })
    // Update display immediately without API refresh
    this.updateDisplayAfterDismiss()
  }

  private updateDisplayAfterDismiss(): void {
    // Get the last known workflows from the dashboard and filter out dismissed ones
    // This avoids an expensive API call just to update the display
    const currentWorkflows = this.dashboard.getCurrentWorkflows()
    const filteredWorkflows = currentWorkflows.filter((run) => {
      if (run.status !== "completed") return true
      return this.completedWorkflows.has(run.id)
    })

    // Update dashboard with filtered workflows immediately
    this.dashboard.updateWorkflows(
      filteredWorkflows,
      this.jobs,
      this.pullRequests,
      this.dockerServices,
    )
  }

  async resurrectOldestWorkflow(): Promise<void> {
    this.dashboard.log(
      `Resurrect called - timestamp: ${this.oldestWorkflowTimestamp}, repos: ${this.repositories.length}`,
      "info",
    )

    if (!this.oldestWorkflowTimestamp || this.repositories.length === 0) {
      this.dashboard.log("No older workflows available to resurrect", "info")
      return
    }

    try {
      this.dashboard.log(
        `Fetching older workflow before ${this.oldestWorkflowTimestamp}...`,
        "info",
      )

      // Fetch one workflow older than our oldest timestamp
      const olderWorkflows = await this.githubService.getOlderWorkflows(
        this.repositories,
        this.oldestWorkflowTimestamp,
        1,
      )

      if (olderWorkflows.length === 0) {
        this.dashboard.log("No older workflows found", "info")
        return
      }

      // Get current workflows
      const currentWorkflows = this.dashboard.getCurrentWorkflows()

      // Add the older workflow as completed (so it shows up but is visually distinct)
      const resurrectedWorkflow = olderWorkflows[0]
      this.completedWorkflows.set(resurrectedWorkflow.id, resurrectedWorkflow)

      // Update oldest timestamp for next resurrect
      this.oldestWorkflowTimestamp = resurrectedWorkflow.createdAt

      // Combine current and resurrected workflows
      const allWorkflows = [...currentWorkflows, resurrectedWorkflow]

      // Update the dashboard
      this.dashboard.updateWorkflows(
        allWorkflows,
        this.jobs,
        this.pullRequests,
        this.dockerServices,
      )

      this.dashboard.log(
        `Resurrected workflow: ${resurrectedWorkflow.name || resurrectedWorkflow.workflowName}`,
        "info",
      )
    } catch (error) {
      this.dashboard.log(
        `Failed to resurrect workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
        "info",
      )
    }
  }

  stop(): void {
    this.stopAutoRefresh()
    this.dashboard.destroy()
  }
}
