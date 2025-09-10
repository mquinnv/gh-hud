import blessed from 'blessed'
import { formatDistanceToNow } from 'date-fns'
import type { WorkflowRun, WorkflowJob } from './types.js'

export class Dashboard {
  private screen: blessed.Widgets.Screen
  private grid: blessed.Widgets.BoxElement[] = []
  private statusBox: blessed.Widgets.BoxElement
  private selectedIndex = 0
  private workflows: WorkflowRun[] = []

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'GitHub Workflow Monitor',
      fullUnicode: true,
      autoPadding: true,
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

    // Set up key bindings
    this.setupKeyBindings()

    // Handle resize
    this.screen.on('resize', () => {
      this.layoutWorkflows()
    })
  }

  private setupKeyBindings(): void {
    this.screen.key(['q', 'C-c'], () => {
      process.exit(0)
    })

    this.screen.key(['r'], () => {
      this.screen.emit('refresh')
    })

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

    this.screen.key(['enter'], () => {
      const workflow = this.workflows[this.selectedIndex]
      if (workflow) {
        this.screen.emit('open-workflow', workflow)
      }
    })

    this.screen.key(['h', '?'], () => {
      this.showHelp()
    })
  }

  private highlightSelected(): void {
    this.grid.forEach((box, index) => {
      if (index === this.selectedIndex) {
        box.style.border = { fg: 'cyan' }
      } else {
        box.style.border = { fg: '#f0f0f0' }
      }
    })
    this.screen.render()
  }

  private showHelp(): void {
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
  h/?     - Show this help
  q/Ctrl+C - Quit

{bold}Status Colors:{/bold}
  {yellow-fg}●{/} Running
  {green-fg}●{/} Success
  {red-fg}●{/} Failed
  {gray-fg}●{/} Queued

Press any key to close...`,
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
      }
    })

    helpBox.focus()
    helpBox.key(['escape', 'q', 'h'], () => {
      helpBox.destroy()
      this.screen.render()
    })

    this.screen.render()
  }

  updateWorkflows(workflows: WorkflowRun[], jobs: Map<string, WorkflowJob[]>): void {
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
        content: `{center}No active workflows found{/center}

{center}Monitoring for workflows...{/center}
{center}Press 'r' to refresh or 'q' to quit{/center}

{center}To trigger a workflow, push to a repository with GitHub Actions{/center}`,
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
            fg: i === this.selectedIndex ? 'cyan' : '#f0f0f0'
          }
        },
        scrollable: true,
        alwaysScroll: true,
        mouse: true,
        keys: true,
        vi: true
      })

      this.grid.push(box)
    }
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

    // Header with repo and workflow name
    lines.push(`{bold}${workflow.repository.owner}/${workflow.repository.name}{/bold}`)
    lines.push(`{cyan-fg}${workflow.workflowName}{/cyan-fg}`)
    lines.push('')

    // Branch and commit info
    lines.push(`Branch: {yellow-fg}${workflow.headBranch}{/yellow-fg}`)
    if (workflow.headCommit) {
      const message = workflow.headCommit.message.split('\n')[0]
      const truncated = message.length > 40 ? message.substring(0, 40) + '...' : message
      lines.push(`Commit: ${truncated}`)
    }
    lines.push('')

    // Status
    const statusIcon = this.getStatusIcon(workflow.status, workflow.conclusion)
    const statusColor = this.getStatusColor(workflow.status, workflow.conclusion)
    lines.push(`Status: {${statusColor}-fg}${statusIcon} ${workflow.status}{/}`)
    
    if (workflow.conclusion) {
      lines.push(`Result: {${statusColor}-fg}${workflow.conclusion}{/}`)
    }

    // Duration
    if (workflow.startedAt) {
      const duration = formatDistanceToNow(new Date(workflow.startedAt), { addSuffix: false })
      lines.push(`Duration: ${duration}`)
    }
    
    lines.push('')

    // Jobs
    if (jobs.length > 0) {
      lines.push('{bold}Jobs:{/bold}')
      jobs.forEach(job => {
        const jobIcon = this.getStatusIcon(job.status, job.conclusion)
        const jobColor = this.getStatusColor(job.status, job.conclusion)
        lines.push(`  {${jobColor}-fg}${jobIcon}{/} ${job.name}`)
        
        // Show current step if in progress
        if (job.status === 'in_progress' && job.steps) {
          const currentStep = job.steps.find(s => s.status === 'in_progress')
          if (currentStep) {
            lines.push(`    → ${currentStep.name}`)
          }
        }
      })
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
    const activeCount = this.workflows.filter(w => w.status !== 'completed').length
    const content = `Last Update: ${now.toLocaleTimeString()} | Active: ${activeCount} | Total: ${this.workflows.length} | Press 'h' for help`
    this.statusBox.setContent(`{center}${content}{/center}`)
  }

  onRefresh(callback: () => void): void {
    this.screen.on('refresh', callback)
  }

  onOpenWorkflow(callback: (workflow: WorkflowRun) => void): void {
    this.screen.on('open-workflow', callback)
  }

  destroy(): void {
    this.screen.destroy()
  }
}
