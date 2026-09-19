import { describe, expect, test } from "bun:test"
import jobsFixture from "../fixtures/github-jobs.json"
import runsFixture from "../fixtures/github-runs.json"
import type { Job } from "../types.js"
import { applyIsFailing, mapGitHubJob, mapGitHubRun } from "./github-map.js"

const rawRun = runsFixture.workflow_runs[0]
const rawJob = jobsFixture.jobs[0]

describe("mapGitHubRun", () => {
  test("produces a github-provider run with a composite key", () => {
    const run = mapGitHubRun(rawRun)
    expect(run.provider).toBe("github")
    expect(run.id).toBe(String(rawRun.id))
    expect(run.key).toBe(`github:${run.repo.fullName}:${run.id}`)
  })

  test("splits owner and name out of the repository full name", () => {
    const run = mapGitHubRun(rawRun)
    expect(run.repo.fullName).toBe(rawRun.repository.full_name)
    expect(`${run.repo.owner}/${run.repo.name}`).toBe(rawRun.repository.full_name)
  })

  // The whole reason for moving off `gh run list --json`: it cannot supply
  // these, so types.ts declared headCommit and github.ts set it to undefined.
  test("populates the commit message and actor gh run list cannot supply", () => {
    const run = mapGitHubRun(rawRun)
    expect(run.commitMessage).toBe(rawRun.head_commit.message)
    expect(run.actor).toBe(rawRun.actor.login)
  })

  // Commit messages are frequently many paragraphs. The card shows one line.
  test("takes the title from the first line only", () => {
    const multiline = {
      ...rawRun,
      head_commit: { ...rawRun.head_commit, message: "first line\n\nbody paragraph" },
    }
    expect(mapGitHubRun(multiline).title).toBe("first line")
  })

  // A 3am scheduled build and someone's push look identical without this.
  test("carries the trigger event through", () => {
    const run = mapGitHubRun(rawRun)
    expect(run.event).toBe(rawRun.event)
  })

  test("prefers run_started_at over created_at for startedAt", () => {
    const run = mapGitHubRun(rawRun)
    expect(run.startedAt).toBe(rawRun.run_started_at)
  })

  test("defaults isFailing to false", () => {
    expect(mapGitHubRun(rawRun).isFailing).toBe(false)
  })

  // GitHub has no finished_at; updated_at is the last write to the run, which
  // for one that has reached a verdict is when it finished. The card needs it
  // to show a duration instead of counting up forever.
  test("takes finishedAt from updated_at once the run has a verdict", () => {
    const run = mapGitHubRun(rawRun)
    expect(run.status).toBe("passed")
    expect(run.finishedAt).toBe(rawRun.updated_at)
  })

  test("leaves finishedAt unset while the run is still going", () => {
    const inFlight = { ...rawRun, status: "in_progress", conclusion: null }
    expect(mapGitHubRun(inFlight).finishedAt).toBeUndefined()
  })
})

describe("mapGitHubJob", () => {
  test("carries steps and the runner name", () => {
    const job = mapGitHubJob(rawJob, "github:acme/widgets:1")
    expect(job.runKey).toBe("github:acme/widgets:1")
    expect(job.id).toBe(String(rawJob.id))
    expect(job.name).toBe(rawJob.name)
    expect(Array.isArray(job.steps)).toBe(true)
  })

  // Job ids collide across providers exactly as run ids do, and the dashboard
  // tracks expanded jobs in one set shared by every card on screen.
  test("gives the job a key that is unique across providers", () => {
    const job = mapGitHubJob(rawJob, "github:acme/widgets:1")
    expect(job.key).toBe(`github:acme/widgets:1:${rawJob.id}`)

    const sameIdElsewhere = mapGitHubJob(rawJob, "buildkite:acme/widgets:1")
    expect(sameIdElsewhere.key).not.toBe(job.key)
  })

  test("leaves the Buildkite-only fields unset", () => {
    const job = mapGitHubJob(rawJob, "github:acme/widgets:1")
    expect(job.command).toBeUndefined()
    expect(job.type).toBeUndefined()
  })
})

describe("applyIsFailing", () => {
  const base = mapGitHubRun(rawRun)
  const job = (status: Job["status"]): Job => ({
    id: "j",
    key: `${base.key}:j`,
    runKey: base.key,
    name: "n",
    status,
  })

  test("flags a running run that already has a failed job", () => {
    const run = applyIsFailing({ ...base, status: "running" }, [job("passed"), job("failed")])
    expect(run.isFailing).toBe(true)
  })

  test("leaves a healthy running run alone", () => {
    const run = applyIsFailing({ ...base, status: "running" }, [job("passed"), job("running")])
    expect(run.isFailing).toBe(false)
  })

  // A finished run already says failed in its own status; isFailing is only
  // meaningful while a run is still going.
  test("never flags a finished run", () => {
    const run = applyIsFailing({ ...base, status: "failed" }, [job("failed")])
    expect(run.isFailing).toBe(false)
  })
})
