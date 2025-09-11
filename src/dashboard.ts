import blessed from 'blessed'
import type { WorkflowRun, WorkflowJob } from './types.js'

export class Dashboard {
  private screen: blessed.Widgets.Screen
  private grid: blessed.Widgets.BoxElement[] = []
  private statusBox: blessed.Widgets.BoxElement
  private selectedIndex = 0
  private workflows: WorkflowRun[] = []
  private isModalOpen = false

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'GitHub Workflow Monitor',
      fullUnicode: true,
      mouse: true,
      sendFocus: true,
      warnings: false
    })

    // Create status bar at the bottom
    this.statusBox = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      tags: true,
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: '#f0f0f0'
        }
      }
    })

    this.screen.append(this.statusBox)

    // Handle screen-level mouse clicks for card selection
    this.screen.on('click', (data) => {
      this.handleScreenClick(data.x, data.y)
    })

    // Set up key bindings
    this.setupKeyBindings()

    // Handle resize
    this.screen.on('resize', () => {
      this.layoutWorkflows()
    })

    // Show initial status (no loading dialog)
    this.showInitialState()
    
    // Ensure screen can receive key events and render
    this.screen.render()
  }

  private setupKeyBindings(): void {
    // Handle quit commands with proper cleanup
    this.screen.key(['q', 'C-c'], () => {
      this.cleanup()
    })

    // Handle manual refresh
    this.screen.key(['r'], () => {
      this.screen.emit('manual-refresh')
    })

    // Navigation keys
    this.screen.key(['up', 'k'], () => {
      if (this.selectedIndex > 0) {
        this.selectedIndex--
        this.highlightSelected()
      }
    })

    this.screen.key(['down', 'j'], () => {
      if (this.selectedIndex < this.workflows.length - 1) {
        this.selectedIndex++
        this.highlightSelected()
      }
    })

    // Open workflow in browser
    this.screen.key(['enter'], () => {
      const workflow = this.workflows[this.selectedIndex]
      if (workflow) {
        this.screen.emit('open-workflow', workflow)
      }
    })

    // Dismiss completed workflow
    this.screen.key(['d'], () => {
      const workflow = this.workflows[this.selectedIndex]
      if (workflow && workflow.status === 'completed') {
        this.screen.emit('dismiss-workflow', workflow)
      }
    })

    // Show help
    this.screen.key(['h', '?'], () => {
      this.showHelp()
    })

    // Also handle process signals for clean shutdown
    process.on('SIGINT', () => this.cleanup())
    process.on('SIGTERM', () => this.cleanup())
  }

  private getBorderColor(workflow: WorkflowRun, isSelected: boolean): string {
    if (isSelected) return 'yellow' // Selected always gets yellow border
    
    if (workflow.status === 'completed') {
      switch (workflow.conclusion) {
        case 'success': return 'green'
        case 'failure': return 'red'
        case 'cancelled': return 'red'
        case 'skipped': return 'gray'
        default: return '#f0f0f0'
      }
    }
    
    return '#f0f0f0' // Default border for active workflows
  }

  private highlightSelected(): void {
    this.grid.forEach((box, index) => {
      const workflow = this.workflows[index]
      if (index === this.selectedIndex) {
        // Selected card: bright yellow border, no background change
        box.style.border = { fg: 'yellow' }
      } else if (workflow) {
        // Unselected workflow: status-based border color
        const borderColor = this.getBorderColor(workflow, false)
        box.style.border = { fg: borderColor }
      } else {
        // Default styling
        box.style.border = { fg: '#f0f0f0' }
      }
    })
    this.screen.render()
  }

  private handleScreenClick(x: number, y: number): void {
    // Find which card was clicked based on coordinates
    for (let i = 0; i < this.grid.length; i++) {
      const box = this.grid[i]
      const left = box.left as number
      const top = box.top as number
      const width = box.width as number
      const height = box.height as number
      
      if (x >= left && x < left + width && y >= top && y < top + height) {
        this.selectedIndex = i
        this.highlightSelected()
        return
      }
    }
  }

  private showHelp(): void {
    this.isModalOpen = true
    const helpBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: '50%',
      content: `
{center}{bold}GitHub Workflow Monitor - Help{/bold}{/center}

{bold}Navigation:{/bold}
  ↑/k     - Move selection up
  ↓/j     - Move selection down
  Enter   - Open workflow in browser
  
{bold}Actions:{/bold}
  r       - Force refresh
  d       - Dismiss completed workflow
  h/?     - Show this help
  q/Ctrl+C - Quit
  
{bold}Mouse:{/bold}
  Click   - Select workflow
  Double-click - Open in browser
  Right-click - Dismiss completed

{bold}Status Colors:{/bold}
  {yellow-fg}●{/} Running
  {green-fg}●{/} Success
  {red-fg}●{/} Failed
  {gray-fg}●{/} Queued

Press 'h' or 'Esc' to close...`,
      tags: true,
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'cyan'
        }
      },
      keys: true,
      mouse: true,
      input: true
    })

    helpBox.focus()
    
    // Close help on any key press
    const closeHelp = () => {
      this.isModalOpen = false
      helpBox.destroy()
      this.screen.render()
    }
    
    // Listen for specific keys to close the help
    helpBox.key(['h', 'escape'], closeHelp)

    this.screen.render()
  }

  private showInitialState(): void {
    // Just show the status bar with loading message - no intrusive dialog
    this.statusBox.setContent('{center}Loading workflows... Press \'q\' to quit{/center}')
    this.screen.render()
  }


  updateWorkflows(workflows: WorkflowRun[], jobs: Map<string, WorkflowJob[]>): void {
    // Don't update the display if a modal dialog is open
    if (this.isModalOpen) {
      // Still update the data but don't re-render the screen
      this.workflows = workflows
      return
    }
    
    this.workflows = workflows
    this.layoutWorkflows()
    this.renderWorkflows(workflows, jobs)
  }

  private layoutWorkflows(): void {
    // Clear existing workflow boxes
    this.grid.forEach(box => box.destroy())
    this.grid = []

    const screenHeight = this.screen.height as number - 3 // Account for status bar
    const screenWidth = this.screen.width as number
    const count = this.workflows.length

    if (count === 0) {
      // Show empty state
      const emptyBox = blessed.box({
        parent: this.screen,
        top: 0,
        left: 0,
        width: '100%',
        height: screenHeight,
        content: `{center}No running workflows found{/center}

{center}Monitoring for in-progress and queued workflows...{/center}
{center}Press 'r' to refresh or 'q' to quit{/center}

{center}Completed workflows will be shown until dismissed{/center}
{center}To see activity, trigger a workflow in your repositories{/center}`,
        tags: true,
        border: {
          type: 'line'
        },
        style: {
          fg: 'gray',
          border: {
            fg: '#f0f0f0'
          }
        }
      })
      this.grid.push(emptyBox)
      return
    }

    // Calculate grid layout
    const cols = Math.min(Math.ceil(Math.sqrt(count)), 3)
    const rows = Math.ceil(count / cols)
    
    const boxWidth = Math.floor(screenWidth / cols)
    const boxHeight = Math.floor(screenHeight / rows)

    // Create grid of boxes
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / cols)
      const col = i % cols
      const workflow = this.workflows[i]
      const borderColor = workflow ? this.getBorderColor(workflow, i === this.selectedIndex) : '#f0f0f0'

      const box = blessed.box({
        parent: this.screen,
        top: row * boxHeight,
        left: col * boxWidth,
        width: boxWidth,
        height: boxHeight,
        tags: true,
        border: {
          type: 'line'
        },
        style: {
          fg: 'white',
          border: {
            fg: borderColor
          }
        },
        scrollable: true,
        alwaysScroll: true,
        mouse: true,
        keys: true,
        vi: true
      })

      // Add mouse click event listener for selection
      box.on('click', () => {
        this.selectedIndex = i
        this.highlightSelected()
      })

      // Add double-click event listener for opening workflow
      box.on('dblclick', () => {
        this.selectedIndex = i
        this.highlightSelected()
        const workflow = this.workflows[i]
        if (workflow) {
          this.screen.emit('open-workflow', workflow)
        }
      })

      // Add right-click event listener for dismissing completed workflows
      box.on('rightclick', () => {
        const workflow = this.workflows[i]
        if (workflow && workflow.status === 'completed') {
          this.screen.emit('dismiss-workflow', workflow)
        }
      })

      this.grid.push(box)
    }
    
    // Ensure selection highlighting is applied after creating all boxes
    this.highlightSelected()
  }

  private renderWorkflows(workflows: WorkflowRun[], jobs: Map<string, WorkflowJob[]>): void {
    workflows.forEach((workflow, index) => {
      if (index >= this.grid.length) return

      const box = this.grid[index]
      const content = this.formatWorkflowContent(workflow, jobs.get(`${workflow.id}`) || [])
      box.setContent(content)
    })

    this.updateStatusBar()
    this.screen.render()
  }

  private formatWorkflowContent(workflow: WorkflowRun, jobs: WorkflowJob[]): string {
    const lines: string[] = []
    
    // Determine if we should show all steps based on number of workflows
    const showAllSteps = this.workflows.length <= 2

    // Header with repo and workflow name
    lines.push(`{bold}${workflow.repository.owner}/${workflow.repository.name}{/bold}`)
    lines.push(`{cyan-fg}${workflow.workflowName}{/cyan-fg}`)
    lines.push(`Run #{yellow-fg}${workflow.runNumber}{/yellow-fg}`)
    lines.push('')

    // Branch and commit info
    lines.push(`Branch: {yellow-fg}${workflow.headBranch}{/yellow-fg}`)
    lines.push(`Event: {magenta-fg}${workflow.event}{/magenta-fg}`)
    if (workflow.headSha) {
      lines.push(`SHA: {gray-fg}${workflow.headSha.substring(0, 7)}{/gray-fg}`)
    }
    lines.push('')

    // Status with more detail
    const statusIcon = this.getStatusIcon(workflow.status, workflow.conclusion)
    const statusColor = this.getStatusColor(workflow.status, workflow.conclusion)
    lines.push(`Status: {${statusColor}-fg}${statusIcon} ${workflow.status.toUpperCase()}{/}`)
    
    if (workflow.conclusion) {
      lines.push(`Result: {${statusColor}-fg}${workflow.conclusion.toUpperCase()}{/}`)
    }

    // Show dismiss hint for completed workflows
    if (workflow.status === 'completed') {
      lines.push(`{gray-fg}Right-click or 'd' to dismiss{/gray-fg}`)
    }

    // Timing information
    if (workflow.startedAt) {
      const startTime = new Date(workflow.startedAt)
      const now = new Date()
      const duration = Math.floor((now.getTime() - startTime.getTime()) / 1000)
      const minutes = Math.floor(duration / 60)
      const seconds = duration % 60
      lines.push(`Running: {white-fg}${minutes}m ${seconds}s{/white-fg}`)
    }
    
    if (workflow.createdAt !== workflow.startedAt) {
      const queueTime = new Date(workflow.startedAt || workflow.createdAt).getTime() - new Date(workflow.createdAt).getTime()
      if (queueTime > 1000) {
        const queueSeconds = Math.floor(queueTime / 1000)
        lines.push(`Queue time: {gray-fg}${queueSeconds}s{/gray-fg}`)
      }
    }
    
    lines.push('')

    // Jobs with detailed step information
    if (jobs.length > 0) {
      lines.push('{bold}Jobs & Steps:{/bold}')
      jobs.forEach(job => {
        const jobIcon = this.getStatusIcon(job.status, job.conclusion)
        const jobColor = this.getStatusColor(job.status, job.conclusion)
        lines.push(`  {${jobColor}-fg}${jobIcon} ${job.name}{/}`)
        
        if (job.steps && job.steps.length > 0) {
          // Show progress for running jobs
          if (job.status === 'in_progress') {
            const completedSteps = job.steps.filter(s => s.status === 'completed').length
            const totalSteps = job.steps.length
            const currentStepIndex = job.steps.findIndex(s => s.status === 'in_progress')
            
            lines.push(`    Progress: {cyan-fg}${completedSteps}/${totalSteps} steps{/cyan-fg}`)
            
            if (currentStepIndex >= 0) {
              // Determine how many steps to show based on available space
              let startIndex: number
              let endIndex: number
              
              if (showAllSteps) {
                // Show all steps when there are few workflows
                startIndex = 0
                endIndex = job.steps.length
              } else {
                // Show 2-3 recently completed steps before current (existing behavior)
                startIndex = Math.max(0, currentStepIndex - 2)
                endIndex = Math.min(job.steps.length, currentStepIndex + 4)
              }
              
              for (let i = startIndex; i < endIndex; i++) {
                const step = job.steps[i]
                const stepNumber = `${i + 1}/${totalSteps}`
                
                if (step.status === 'completed') {
                  const stepIcon = step.conclusion === 'success' ? '✓' : 
                                   step.conclusion === 'failure' ? '✗' : 
                                   step.conclusion === 'skipped' ? '⊜' : '○'
                  const stepColor = step.conclusion === 'success' ? 'green' : 
                                    step.conclusion === 'failure' ? 'red' : 'gray'
                  
                  let duration = ''
                  if (step.startedAt && step.completedAt) {
                    const dur = Math.floor((new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) / 1000)
                    duration = ` (${dur}s)`
                  }
                  
                  lines.push(`    {${stepColor}-fg}${stepIcon}{/} {gray-fg}${stepNumber}{/} ${step.name}{gray-fg}${duration}{/}`)
                } else if (step.status === 'in_progress') {
                  // Current running step - highlighted
                  const stepDuration = step.startedAt ? 
                    Math.floor((new Date().getTime() - new Date(step.startedAt).getTime()) / 1000) : 0
                  
                  lines.push(`    {yellow-fg}▶ ${stepNumber} {bold}${step.name}{/bold} (${stepDuration}s){/}`)
                } else {
                  // Upcoming steps (pending, waiting)
                  const stepIcon = step.status === 'waiting' ? '⏳' : '○'
                  lines.push(`    {gray-fg}${stepIcon} ${stepNumber} ${step.name}{/}`)
                }
              }
              
              // Show if there are more steps after what we're displaying (only when not showing all)
              if (!showAllSteps && endIndex < job.steps.length) {
                const remainingSteps = job.steps.length - endIndex
                lines.push(`    {gray-fg}... and ${remainingSteps} more step${remainingSteps > 1 ? 's' : ''}{/}`)
              }
            }
          }
          
          // Show completion info for completed jobs
          else if (job.status === 'completed') {
            if (showAllSteps && job.steps && job.steps.length > 0) {
              // Show all completed steps with details when there's room
              job.steps.forEach((step, index) => {
                const stepNumber = `${index + 1}/${job.steps!.length}`
                const stepIcon = step.conclusion === 'success' ? '✓' : 
                                 step.conclusion === 'failure' ? '✗' : 
                                 step.conclusion === 'skipped' ? '⊜' : '○'
                const stepColor = step.conclusion === 'success' ? 'green' : 
                                  step.conclusion === 'failure' ? 'red' : 'gray'
                
                let duration = ''
                if (step.startedAt && step.completedAt) {
                  const dur = Math.floor((new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) / 1000)
                  duration = ` (${dur}s)`
                }
                
                lines.push(`    {${stepColor}-fg}${stepIcon}{/} {gray-fg}${stepNumber}{/} ${step.name}{gray-fg}${duration}{/}`)
              })
            } else {
              // Show summary when there's limited space (existing behavior)
              if (job.conclusion === 'success') {
                lines.push(`    {green-fg}✓ All ${job.steps.length} steps completed{/green-fg}`)
              } else if (job.conclusion === 'failure') {
                const failedStep = job.steps.find(s => s.conclusion === 'failure')
                if (failedStep) {
                  lines.push(`    {red-fg}✗ Failed at: ${failedStep.name}{/red-fg}`)
                }
              }
            }
          }
          
          // Show queued job steps when there's room
          else if (showAllSteps && (job.status === 'queued' || job.status === 'waiting')) {
            if (job.steps && job.steps.length > 0) {
              lines.push(`    {gray-fg}Queued - ${job.steps.length} steps pending{/gray-fg}`)
              job.steps.forEach((step, index) => {
                const stepNumber = `${index + 1}/${job.steps!.length}`
                lines.push(`    {gray-fg}○ ${stepNumber} ${step.name}{/gray-fg}`)
              })
            } else {
              lines.push(`    {gray-fg}Waiting to start...{/gray-fg}`)
            }
          }
        }
        
        lines.push('')
      })
    } else {
      lines.push('{gray-fg}Loading job details...{/gray-fg}')
    }

    return lines.join('\n')
  }

  private getStatusIcon(status: string, conclusion?: string): string {
    if (status === 'completed') {
      switch (conclusion) {
        case 'success': return '✓'
        case 'failure': return '✗'
        case 'cancelled': return '⊘'
        case 'skipped': return '⊜'
        default: return '?'
      }
    }
    
    switch (status) {
      case 'in_progress': return '●'
      case 'queued': return '○'
      default: return '?'
    }
  }

  private getStatusColor(status: string, conclusion?: string): string {
    if (status === 'completed') {
      switch (conclusion) {
        case 'success': return 'green'
        case 'failure': return 'red'
        case 'cancelled': return 'gray'
        case 'skipped': return 'gray'
        default: return 'white'
      }
    }
    
    switch (status) {
      case 'in_progress': return 'yellow'
      case 'queued': return 'gray'
      default: return 'white'
    }
  }

  private updateStatusBar(): void {
    const now = new Date()
    const runningCount = this.workflows.filter(w => w.status === 'in_progress').length
    const queuedCount = this.workflows.filter(w => w.status === 'queued' || w.status === 'waiting').length
    const completedCount = this.workflows.filter(w => w.status === 'completed').length
    
    let content = `Last Update: ${now.toLocaleTimeString()} | Running: ${runningCount} | Queued: ${queuedCount}`
    if (completedCount > 0) {
      content += ` | Completed: ${completedCount} (awaiting dismissal)`
    }
    content += ` | Total: ${this.workflows.length} | Press 'h' for help`
    
    this.statusBox.setContent(`{center}${content}{/center}`)
  }

  onRefresh(callback: () => void): void {
    this.screen.on('manual-refresh', callback)
  }

  onOpenWorkflow(callback: (workflow: WorkflowRun) => void): void {
    this.screen.on('open-workflow', callback)
  }

  onDismissWorkflow(callback: (workflow: WorkflowRun) => void): void {
    this.screen.on('dismiss-workflow', callback)
  }

  showError(message: string): void {
    // Clear existing content
    this.grid.forEach(box => box.destroy())
    this.grid = []

    const errorBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '80%',
      height: '60%',
      content: `{center}{bold}Error Loading Workflows{/bold}{/center}

{red-fg}${message}{/red-fg}

{center}Press 'r' to retry or 'q' to quit{/center}`,
      tags: true,
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        border: {
          fg: 'red'
        }
      }
    })

    this.grid.push(errorBox)
    this.updateStatusBar()
    this.screen.render()
  }

  private cleanup(): void {
    // Emit exit event for the app to handle
    this.screen.emit('exit')
    // Clean shutdown
    this.destroy()
    process.exit(0)
  }

  onExit(callback: () => void): void {
    this.screen.on('exit', callback)
  }

  showLoadingInStatus(): void {
    // Don't update status if modal is open
    if (this.isModalOpen) return
    
    // Public method to show loading in status bar
    const now = new Date()
    this.statusBox.setContent(`{center}Refreshing... | Last Update: ${now.toLocaleTimeString()} | Press 'h' for help{/center}`)
    this.screen.render()
  }

  destroy(): void {
    // Clean up any event listeners
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
    
    // Destroy the blessed screen
    if (this.screen) {
      this.screen.destroy()
    }
  }
}
