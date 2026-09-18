import { parseGitHubRemote } from "../config.js"
import { fromBuildkite } from "../status.js"
import type { Job, Run } from "../types.js"

// Shapes of the `GET /v2/organizations/{org}/builds` and
// `GET /v2/organizations/{org}/pipelines` responses — only the fields we
// actually read. The real API returns `null` (not absent) for several of
// these, so the optional fields below are typed `| null` to tell the truth;
// callers normalise every one of them to `undefined` on the way into the
// neutral model.

export interface BuildkitePipelinePayload {
  slug: string
  name: string
  repository: string
}

export interface BuildkiteJobPayload {
  id: string
  type?: string
  name?: string | null
  label?: string | null
  step_key?: string | null
  state: string
  command?: string | null
  web_url?: string
  /** Where to `GET` this job's log text. Absent on jobs that never ran. */
  log_url?: string
  agent?: { name?: string | null } | null
  started_at?: string | null
  finished_at?: string | null
}

export interface BuildkiteBuildPayload {
  id: string
  number: number
  state: string
  message?: string | null
  commit: string
  branch: string
  web_url: string
  created_at: string
  started_at?: string | null
  finished_at?: string | null
  /** What kicked the build off: webhook, schedule, api, ui, trigger_job. */
  source?: string
  creator?: { name?: string | null } | null
  pipeline: BuildkitePipelinePayload
  jobs: BuildkiteJobPayload[]
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0].trim()
}

// Real Buildkite job names/labels are routinely emoji shortcodes meant to
// render as an icon, e.g. `:gradle: test + explode, build + push image` or
// `:docker::k8s: deploy` (adjacent shortcodes count as one token). A terminal
// shows the literal `:gradle:` text instead, which reads as noise on a
// narrow card, so strip it — but only as a whole whitespace-delimited token,
// never mid-word. Colon-namespaced names like `deploy:prod:us-east` or plain
// timestamps like `12:30:45` are common in CI and must survive untouched.
const SHORTCODE = /(?<=^|\s)(?::[a-z0-9_+-]+:)+(?=\s|$)/g

function cleanJobName(raw: string): string {
  const stripped = raw.replace(SHORTCODE, "").replace(/\s+/g, " ").trim()
  // A name that is *only* a shortcode (`:rocket:`) would otherwise vanish
  // entirely — fall back to the raw, uncleaned name rather than showing "".
  return stripped || raw
}

/**
 * Pipelines store their repository as a git remote — `git@github.com:o/r.git`
 * or the https form. `parseGitHubRemote` already handles both and strips
 * `.git`, so the same parser that resolves a local checkout resolves a
 * pipeline. Non-GitHub remotes simply do not participate.
 */
export function indexPipelinesByRepo(pipelines: BuildkitePipelinePayload[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const pipeline of pipelines) {
    const repo = parseGitHubRemote(pipeline.repository ?? "")
    if (!repo) continue
    const slugs = index.get(repo)
    if (slugs) slugs.push(pipeline.slug)
    else index.set(repo, [pipeline.slug])
  }
  return index
}

function repoFromPipeline(pipeline: BuildkitePipelinePayload): Run["repo"] {
  const githubRepo = parseGitHubRemote(pipeline.repository ?? "")
  if (githubRepo) {
    const [owner, name] = githubRepo.split("/")
    return { owner, name, fullName: githubRepo }
  }
  // A non-GitHub remote (or one that fails to parse) has no owner to offer.
  // Fall back to the pipeline slug explicitly, rather than splitting it and
  // accidentally reusing it as both owner and name (`slug/slug`).
  return { owner: "", name: pipeline.slug, fullName: pipeline.slug }
}

export function mapBuildkiteBuild(raw: BuildkiteBuildPayload): Run {
  const repo = repoFromPipeline(raw.pipeline)
  const fullName = repo.fullName
  const message = raw.message ?? undefined

  return {
    provider: "buildkite",
    key: `buildkite:${fullName}:${raw.id}`,
    id: raw.id,
    number: raw.number,
    title: message ? firstLine(message) : raw.pipeline.name,
    pipeline: raw.pipeline.name,
    pipelineSlug: raw.pipeline.slug,
    branch: raw.branch,
    sha: raw.commit,
    status: fromBuildkite(raw.state),
    // Buildkite reports this directly; GitHub has to derive it from jobs.
    isFailing: raw.state === "failing",
    repo,
    actor: raw.creator?.name ?? undefined,
    // Buildkite's `source` (webhook, schedule, api, ...) is the same concept
    // as GitHub's `event`, under a different name.
    event: raw.source,
    commitMessage: message,
    webUrl: raw.web_url,
    createdAt: raw.created_at,
    startedAt: raw.started_at ?? undefined,
    finishedAt: raw.finished_at ?? undefined,
  }
}

const JOB_TYPES = new Set(["script", "manual", "trigger", "waiter"])

export function mapBuildkiteJob(raw: BuildkiteJobPayload, runKey: string): Job {
  const type = raw.type && JOB_TYPES.has(raw.type) ? (raw.type as Job["type"]) : undefined
  const rawName = raw.name ?? raw.label ?? raw.command ?? "(unnamed)"

  return {
    id: raw.id,
    key: `${runKey}:${raw.id}`,
    runKey,
    // Buildkite jobs are frequently named only by an emoji label.
    name: cleanJobName(rawName),
    status: fromBuildkite(raw.state),
    startedAt: raw.started_at ?? undefined,
    finishedAt: raw.finished_at ?? undefined,
    agent: raw.agent?.name ?? undefined,
    webUrl: raw.web_url,
    command: raw.command ?? undefined,
    type,
    // Deliberately no `steps`: a Buildkite job IS a step.
  }
}
