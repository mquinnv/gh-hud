# Fixtures

`github-runs.json` and `github-jobs.json` are real `gh api` captures.

`buildkite-builds.json` and `buildkite-pipelines.json` are derived from
Buildkite's REST API reference shape rather than captured live — no
Buildkite API token was available in the environment that wrote them. They
should be re-captured with `curl` (without `exclude_jobs`) once a token is
available; see `.superpowers/sdd/2026-09-17-ops-hud-buildkite/task-5-brief.md`
step 1 for the exact commands.
