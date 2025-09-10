export interface WorkflowRun {
  id: number
  name: string
  headBranch: string
  headSha: string
  runNumber: number
  event: string
  status: 'queued' | 'in_progress' | 'completed' | 'waiting'
  conclusion?: 'success' | 'failure' | 'cancelled' | 'neutral' | 'skipped' | 'timed_out' | 'action_required'
  workflowId: number
  workflowName: string
  url: string
  htmlUrl: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  repository: {
    owner: string
    name: string
  }
  headCommit?: {
    message: string
    author: {
      name: string
      email: string
    }
  }
}

export interface WorkflowJob {
  id: number
  runId: number
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?: 'success' | 'failure' | 'cancelled' | 'neutral' | 'skipped' | 'timed_out' | 'action_required'
  startedAt?: string
  completedAt?: string
  steps?: WorkflowStep[]
}

export interface WorkflowStep {
  name: string
  status: 'queued' | 'in_progress' | 'completed' | 'pending' | 'waiting'
  conclusion?: 'success' | 'failure' | 'cancelled' | 'neutral' | 'skipped'
  number: number
  startedAt?: string
  completedAt?: string
}

export interface Repository {
  owner: string
  name: string
  fullName: string
}

export interface Config {
  repositories?: string[]
  organizations?: string[]
  refreshInterval?: number
  maxWorkflows?: number
  filterStatus?: string[]
  showCompletedFor?: number // minutes to show completed workflows
}

export interface DashboardState {
  workflows: Map<string, WorkflowRun>
  jobs: Map<string, WorkflowJob[]>
  lastUpdate: Date
  error?: string
}
