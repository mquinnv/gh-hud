import { describe, expect, test } from "bun:test"
import { execa } from "execa"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import { isAbsolute, join } from "path"
import { ConfigManager, parseGitHubRemote, resolveRepoAtPath, resolveScope } from "./config.js"
import type { GitHubService } from "./github.js"
import type { Repository } from "./types.js"

// A GitHubService whose org listing returns a repo we should never see once
// an explicit scope is in play — if it leaks into the result, orgs weren't cleared.
function githubReturningOrgRepo(fullName: string): GitHubService {
  return {
    listRepositories: async (): Promise<Repository[]> => [{ fullName } as Repository],
  } as unknown as GitHubService
}

describe("parseGitHubRemote", () => {
  test("parses an SSH remote", () => {
    expect(parseGitHubRemote("git@github.com:acme/widgets.git")).toBe("acme/widgets")
  })

  test("parses an HTTPS remote", () => {
    expect(parseGitHubRemote("https://github.com/acme/widgets.git")).toBe("acme/widgets")
  })

  test("parses a remote with no .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/acme/widgets")).toBe("acme/widgets")
  })

  test("keeps dots in the repository name", () => {
    expect(parseGitHubRemote("git@github.com:mrdoob/three.js.git")).toBe("mrdoob/three.js")
  })

  test("returns null for a non-GitHub remote", () => {
    expect(parseGitHubRemote("git@gitlab.com:acme/widgets.git")).toBeNull()
  })
})

describe("explicit repository scope", () => {
  test("suppresses organizations configured in the config file", async () => {
    const config = new ConfigManager()
    config.updateFromArgs({ organizations: ["ameriglide"] })

    config.setScopedRepositories(["acme/widgets"])
    const repos = await config.buildRepositoryList(githubReturningOrgRepo("ameriglide/other"))

    expect(repos).toEqual(["acme/widgets"])
  })

  test("leaves organizations alone when nothing is explicitly scoped", async () => {
    const config = new ConfigManager()
    config.updateFromArgs({ organizations: ["ameriglide"] })

    const repos = await config.buildRepositoryList(githubReturningOrgRepo("ameriglide/other"))

    expect(repos).toEqual(["ameriglide/other"])
  })
})

describe("resolveRepoAtPath", () => {
  test("resolves a checkout's GitHub remote to owner/repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-hud-test-"))
    await execa("git", ["init", "-q"], { cwd: dir })
    await execa("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir })

    expect(await resolveRepoAtPath(dir)).toBe("acme/widgets")
  })

  test("returns null for a directory that is not a git checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-hud-test-"))

    expect(await resolveRepoAtPath(dir)).toBeNull()
  })
})

describe("resolveScope", () => {
  test("returns the repo and an absolute directory for a checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-hud-test-"))
    await execa("git", ["init", "-q"], { cwd: dir })
    await execa("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir })

    const scope = await resolveScope(dir)

    expect(scope.repo).toBe("acme/widgets")
    expect(isAbsolute(scope.dir)).toBe(true)
  })

  test("rejects a path that does not exist, naming the path", async () => {
    const missing = join(tmpdir(), "gh-hud-test-does-not-exist")

    expect(resolveScope(missing)).rejects.toThrow(missing)
  })

  test("rejects a directory that has no GitHub remote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-hud-test-"))

    expect(resolveScope(dir)).rejects.toThrow(/GitHub/)
  })
})
