import { describe, expect, test } from "bun:test"
import type { Run } from "../types.js"
import { BuildkiteProvider, nextLink, resolveBuildkiteToken } from "./buildkite.js"
import type { Scope } from "./types.js"

const emptyScope: Scope = { repositories: [], organizations: [] }

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: init?.headers,
  })
}

function sampleRun(overrides: Partial<Run> = {}): Run {
  return {
    provider: "buildkite",
    key: "buildkite:inetalliance/usm:abc",
    id: "abc",
    number: 42,
    title: "a title",
    pipeline: "site-content-usm",
    pipelineSlug: "site-content-usm",
    branch: "main",
    sha: "deadbeef",
    status: "running",
    isFailing: false,
    repo: { owner: "inetalliance", name: "usm", fullName: "inetalliance/usm" },
    webUrl: "https://buildkite.com/ameriglide/site-content-usm/builds/42",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("resolveBuildkiteToken", () => {
  test("prefers the environment variable over config", () => {
    expect(resolveBuildkiteToken({ BUILDKITE_API_TOKEN: "env" }, { token: "cfg" })).toBe("env")
  })

  test("falls back to config", () => {
    expect(resolveBuildkiteToken({}, { token: "cfg" })).toBe("cfg")
  })

  test("returns undefined when neither is set", () => {
    expect(resolveBuildkiteToken({}, {})).toBeUndefined()
    expect(resolveBuildkiteToken({}, undefined)).toBeUndefined()
  })

  // An empty string in config is a half-finished edit, not a token.
  test("treats blank values as absent", () => {
    expect(resolveBuildkiteToken({ BUILDKITE_API_TOKEN: "  " }, { token: "" })).toBeUndefined()
  })
})

describe("nextLink", () => {
  test("returns undefined when there is no header", () => {
    expect(nextLink(null)).toBeUndefined()
  })

  test("extracts the rel=next URL among other rels", () => {
    const header =
      '<https://api.buildkite.com/v2/x?page=1>; rel="prev", <https://api.buildkite.com/v2/x?page=2>; rel="next"'
    expect(nextLink(header)).toBe("https://api.buildkite.com/v2/x?page=2")
  })

  test("returns undefined when there is no next rel", () => {
    const header = '<https://api.buildkite.com/v2/x?page=1>; rel="prev"'
    expect(nextLink(header)).toBeUndefined()
  })
})

describe("BuildkiteProvider without a token", () => {
  // The tool must stay installable and useful for people with no Buildkite
  // account at all, so this path is a skip, not an error.
  test("skips quietly and contributes nothing", async () => {
    const provider = new BuildkiteProvider({ token: undefined })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].level).toBe("info")
    expect(result.diagnostics[0].message).toContain("no token")
  })

  test("does not implement fetchOlderRuns — Buildkite opts out of resurrect", () => {
    const provider = new BuildkiteProvider({ token: undefined })
    expect(provider.fetchOlderRuns).toBeUndefined()
  })
})

describe("BuildkiteProvider with a failing token", () => {
  // The opposite rule: a token that is present and broken must be loud, or a
  // misconfiguration is indistinguishable from an idle CI system.
  test("reports a rejected token as an error", async () => {
    const provider = new BuildkiteProvider({
      token: "bad",
      org: "acme",
      fetch: async () => new Response("", { status: 401 }),
    })
    const result = await provider.fetchRuns({
      ...emptyScope,
      buildkite: { org: "acme", pipelines: [] },
    })
    expect(result.runs).toEqual([])
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("rejected")
  })

  test("reports an ambiguous organization", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      fetch: async () => jsonResponse([{ slug: "one" }, { slug: "two" }]),
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("one")
    expect(result.diagnostics[0].message).toContain("two")
  })

  test("reports token reaching no organizations", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      fetch: async () => jsonResponse([]),
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("no organizations")
  })

  test("auto-detects a sole organization", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      fetch: async (url: string) => {
        if (url.endsWith("/organizations")) {
          return jsonResponse([{ slug: "ameriglide" }])
        }
        return jsonResponse([])
      },
    })
    const result = await provider.fetchRuns(emptyScope)
    expect(result.diagnostics.some((d) => d.level === "error")).toBe(false)
  })
})

describe("BuildkiteProvider.fetchRuns endpoint selection", () => {
  const pipelinePayload = [
    {
      id: "p1",
      url: "x",
      web_url: "x",
      name: "site-content-usm",
      slug: "site-content-usm",
      repository: "git@github.com:inetalliance/usm.git",
    },
  ]

  function buildPayload(id: string, number: number) {
    return {
      id,
      number,
      state: "passed",
      commit: "deadbeef",
      branch: "main",
      web_url: "https://buildkite.com/x",
      created_at: "2026-01-01T00:00:00Z",
      pipeline: {
        slug: "site-content-usm",
        name: "site-content-usm",
        repository: "git@github.com:inetalliance/usm.git",
      },
      jobs: [],
    }
  }

  test("scoped repositories fetch per-pipeline builds, not the org-wide endpoint", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        requestedUrls.push(url)
        if (url.includes("/pipelines?")) return jsonResponse(pipelinePayload)
        if (url.includes("/pipelines/site-content-usm/builds")) {
          return jsonResponse([buildPayload("b1", 1)])
        }
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns({
      repositories: ["inetalliance/usm"],
      organizations: [],
    })

    expect(result.runs).toHaveLength(1)
    expect(
      requestedUrls.some((u) =>
        u.includes("/organizations/acme/pipelines/site-content-usm/builds"),
      ),
    ).toBe(true)
    expect(requestedUrls.some((u) => u.endsWith("/organizations/acme/builds?per_page=20"))).toBe(
      false,
    )
  })

  test("unscoped fetch hits the org-wide builds endpoint, not any pipeline endpoint", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        requestedUrls.push(url)
        if (url.includes("/pipelines?")) return jsonResponse(pipelinePayload)
        if (url.includes("/organizations/acme/builds")) return jsonResponse([buildPayload("b1", 1)])
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns(emptyScope)

    expect(result.runs).toHaveLength(1)
    expect(requestedUrls.some((u) => u.includes("/organizations/acme/builds?per_page=20"))).toBe(
      true,
    )
    expect(requestedUrls.some((u) => u.includes("/pipelines/") && u.includes("/builds"))).toBe(
      false,
    )
  })

  test("a scoped repo with no matching pipeline produces an info diagnostic naming it", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("/pipelines?")) return jsonResponse(pipelinePayload)
        return jsonResponse([])
      },
    })

    const result = await provider.fetchRuns({
      repositories: ["inetalliance/no-such-repo"],
      organizations: [],
    })

    expect(result.runs).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].level).toBe("info")
    expect(result.diagnostics[0].message).toContain("inetalliance/no-such-repo")
  })

  test("never sends exclude_jobs on any request", async () => {
    const requestedUrls: string[] = []
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        requestedUrls.push(url)
        if (url.includes("/pipelines?")) return jsonResponse(pipelinePayload)
        return jsonResponse([buildPayload("b1", 1)])
      },
    })

    await provider.fetchRuns({ repositories: ["inetalliance/usm"], organizations: [] })
    await provider.fetchRuns(emptyScope)

    expect(requestedUrls.some((u) => u.includes("exclude_jobs"))).toBe(false)
  })

  test("follows Link: rel=next across two pages of builds", async () => {
    let calls = 0
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("/pipelines?")) return jsonResponse([])
        calls++
        if (calls === 1) {
          return jsonResponse([buildPayload("b1", 1)], {
            headers: {
              link: '<https://api.buildkite.com/v2/organizations/acme/builds?per_page=20&page=2>; rel="next"',
            },
          })
        }
        return jsonResponse([buildPayload("b2", 2)])
      },
    })

    const result = await provider.fetchRuns(emptyScope)
    expect(result.runs).toHaveLength(2)
    expect(calls).toBe(2)
  })
})

describe("BuildkiteProvider.fetchJobs", () => {
  test("always returns empty — jobs arrive embedded with the build", async () => {
    const provider = new BuildkiteProvider({ token: "good", org: "acme" })
    const jobs = await provider.fetchJobs(sampleRun())
    expect(jobs).toEqual([])
  })
})

describe("BuildkiteProvider actions", () => {
  test("cancel issues a PUT to the cancel endpoint", async () => {
    let method: string | undefined
    let url: string | undefined
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (u: string, init?: RequestInit) => {
        url = u
        method = init?.method
        return jsonResponse({})
      },
    })

    await provider.cancel(sampleRun())
    expect(method).toBe("PUT")
    expect(url).toBe(
      "https://api.buildkite.com/v2/organizations/acme/pipelines/site-content-usm/builds/42/cancel",
    )
  })

  test("rerun issues a PUT to the rebuild endpoint", async () => {
    let method: string | undefined
    let url: string | undefined
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (u: string, init?: RequestInit) => {
        url = u
        method = init?.method
        return jsonResponse({})
      },
    })

    await provider.rerun(sampleRun())
    expect(method).toBe("PUT")
    expect(url).toBe(
      "https://api.buildkite.com/v2/organizations/acme/pipelines/site-content-usm/builds/42/rebuild",
    )
  })

  test("cancel rejects a run with no pipeline slug", async () => {
    const provider = new BuildkiteProvider({ token: "good", org: "acme" })
    await expect(provider.cancel(sampleRun({ pipelineSlug: undefined }))).rejects.toThrow()
  })
})

describe("BuildkiteProvider.logs", () => {
  function jobPayload(overrides: Record<string, unknown>) {
    return {
      id: "j",
      state: "passed",
      ...overrides,
    }
  }

  test("prefers the first failed or timed-out job with a log_url", async () => {
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("/log")) return jsonResponse({ content: "failure output" })
        return jsonResponse({
          id: "b1",
          number: 42,
          state: "failed",
          commit: "deadbeef",
          branch: "main",
          web_url: "x",
          created_at: "2026-01-01T00:00:00Z",
          pipeline: { slug: "site-content-usm", name: "site-content-usm", repository: "x" },
          jobs: [
            jobPayload({
              id: "upload",
              state: "passed",
              log_url: "https://api.buildkite.com/v2/log/upload",
            }),
            jobPayload({
              id: "failing",
              state: "failed",
              log_url: "https://api.buildkite.com/v2/log/failing",
            }),
            jobPayload({
              id: "later",
              state: "passed",
              log_url: "https://api.buildkite.com/v2/log/later",
            }),
          ],
        })
      },
    })

    const content = await provider.logs(sampleRun())
    expect(content).toBe("failure output")
  })

  test("falls back to the last job with a log_url when nothing failed", async () => {
    let requestedLogUrl: string | undefined
    const provider = new BuildkiteProvider({
      token: "good",
      org: "acme",
      fetch: async (url: string) => {
        if (url.includes("/log/")) {
          requestedLogUrl = url
          return jsonResponse({ content: "last job output" })
        }
        return jsonResponse({
          id: "b1",
          number: 42,
          state: "passed",
          commit: "deadbeef",
          branch: "main",
          web_url: "x",
          created_at: "2026-01-01T00:00:00Z",
          pipeline: { slug: "site-content-usm", name: "site-content-usm", repository: "x" },
          jobs: [
            jobPayload({
              id: "upload",
              state: "passed",
              log_url: "https://api.buildkite.com/v2/log/upload",
            }),
            jobPayload({
              id: "build",
              state: "passed",
              log_url: "https://api.buildkite.com/v2/log/build",
            }),
          ],
        })
      },
    })

    const content = await provider.logs(sampleRun())
    expect(content).toBe("last job output")
    expect(requestedLogUrl).toBe("https://api.buildkite.com/v2/log/build")
  })
})
