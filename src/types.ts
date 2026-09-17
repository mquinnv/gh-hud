import type { RunStatus } from "./status.js"

export type Provider = "github" | "buildkite"

export interface Step {
  name: string
  status: RunStatus
  number: number
  startedAt?: string
  finishedAt?: string
}

export interface Job {
  id: string
  runKey: string
  name: string
  status: RunStatus
  startedAt?: string
  finishedAt?: string
  agent?: string
  webUrl?: string
  steps?: Step[]
  command?: string
  type?: "script" | "manual" | "trigger" | "waiter"
}

export interface Run {
  provider: Provider
  /** Stable grid identity: `${provider}:${repo.fullName}:${id}`. */
  key: string
  /** Native id as a string. GitHub: databaseId. Buildkite: build UUID. */
  id: string
  /** run_number (GitHub) or build number (Buildkite). */
  number: number
  /** First line of the commit message, or GitHub's display_title. */
  title: string
  /** Workflow name (GitHub) or pipeline name (Buildkite), for display. */
  pipeline: string
  /** Buildkite only: required to address the build write endpoints. */
  pipelineSlug?: string
  branch: string
  sha: string
  status: RunStatus
  /** Running, but a job has already failed. */
  isFailing: boolean
  repo: { owner: string; name: string; fullName: string }
  actor?: string
  commitMessage?: string
  webUrl: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface Repository {
  owner: string
  name: string
  fullName: string
}

export interface BuildkiteConfig {
  /** Prefer $BUILDKITE_API_TOKEN, which always takes precedence over this. */
  token?: string
  /** Auto-detected when the token reaches exactly one organization. */
  org?: string
  /** Explicit pipeline slugs. Empty means: derive from `repositories`. */
  pipelines?: string[]
}

export interface Config {
  repositories?: string[]
  organizations?: string[]
  refreshInterval?: number
  maxWorkflows?: number
  filterStatus?: string[]
  showCompletedFor?: number // minutes to show completed workflows
  buildkite?: BuildkiteConfig
}

export interface PullRequest {
  id: number
  number: number
  title: string
  state: "open" | "closed"
  draft: boolean
  user: {
    login: string
  }
  headRefName: string
  baseRefName: string
  url: string
  createdAt: string
  updatedAt: string
  repository: {
    owner: string
    name: string
  }
  statusCheckRollup?: {
    state: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED"
  }
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED"
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  isDraft?: boolean
}

export interface DashboardState {
  runs: Map<string, Run>
  jobs: Map<string, Job[]>
  pullRequests?: PullRequest[]
  dockerServices?: DockerServiceStatus[]
  lastUpdate: Date
  error?: string
}

export interface DockerService {
  name: string
  containerName: string
  state: "running" | "exited" | "paused" | "restarting" | "dead" | "removing" | "created"
  status: string // e.g., "Up 2 hours", "Exited (0) 5 minutes ago"
  health?: "healthy" | "unhealthy" | "starting" | "none"
  ports?: string[]
}

export interface DockerServiceStatus {
  repository: string // e.g., "owner/repo"
  composeFile: string // path to docker-compose file
  services: DockerService[]
  error?: string
}

export interface DockerComposeConfig {
  services: Record<string, unknown>
}
