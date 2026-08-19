import { execa } from "execa"
import { existsSync } from "fs"
import { readFile } from "fs/promises"
import { homedir } from "os"
import { join, resolve } from "path"
import type { Dashboard } from "./dashboard.js"
import type { GitHubService } from "./github.js"
import type { Config, Repository } from "./types.js"

// Extract "owner/repo" from a GitHub remote URL, or null if it isn't one.
// Handles https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git).
export function parseGitHubRemote(url: string): string | null {
  // Strip .git first so repo names containing dots (three.js) survive intact.
  const cleaned = url.trim().replace(/\.git$/, "")
  const match = cleaned.match(/github\.com[:/]([^/]+)\/([^/]+)$/)
  return match ? `${match[1]}/${match[2]}` : null
}

// Resolve the GitHub repository that owns `dir`, or null if there isn't one.
export async function resolveRepoAtPath(dir: string): Promise<string | null> {
  try {
    // gh knows about renames and non-origin remotes, so prefer it.
    const { stdout } = await execa("gh", ["repo", "view", "--json", "owner,name"], {
      cwd: dir,
      timeout: 2000,
    })
    const repoInfo = JSON.parse(stdout)
    if (repoInfo.owner?.login && repoInfo.name) {
      return `${repoInfo.owner.login}/${repoInfo.name}`
    }
  } catch {
    // Fall through to parsing the git remote directly.
  }

  try {
    const { stdout } = await execa("git", ["remote", "get-url", "origin"], { cwd: dir })
    return parseGitHubRemote(stdout)
  } catch {
    return null
  }
}

// Turn a user-supplied path into the repository to monitor. Throws with a
// message meant for stderr — the caller must fail before blessed takes the
// screen, or the error becomes an invisible empty dashboard.
export async function resolveScope(path: string): Promise<{ repo: string; dir: string }> {
  const dir = resolve(path)

  if (!existsSync(dir)) {
    throw new Error(`No such directory: ${dir}`)
  }

  const repo = await resolveRepoAtPath(dir)
  if (!repo) {
    throw new Error(`Not a GitHub checkout (no github.com remote found): ${dir}`)
  }

  return { repo, dir }
}

const DEFAULT_CONFIG: Config = {
  repositories: [],
  organizations: [], // Don't default to any orgs
  refreshInterval: 5000, // 5 seconds
  maxWorkflows: 20,
  filterStatus: [], // Show all statuses by default
  showCompletedFor: 60, // minutes - show completed for longer
}

export class ConfigManager {
  private config: Config = { ...DEFAULT_CONFIG }

  async loadConfig(configPath?: string): Promise<Config> {
    const paths = [
      configPath,
      ".gh-hud.json",
      join(homedir(), ".gh-hud.json"),
      join(homedir(), ".config", "gh-hud", "config.json"),
    ].filter(Boolean) as string[]

    for (const path of paths) {
      try {
        const content = await readFile(path, "utf-8")
        const userConfig = JSON.parse(content)
        this.config = { ...DEFAULT_CONFIG, ...userConfig }
        break
      } catch (_error) {
        // Config file doesn't exist or is invalid, continue to next
      }
    }

    return this.config
  }

  updateFromArgs(args: Partial<Config>): void {
    this.config = { ...this.config, ...args }
  }

  // An explicit scope (a path argument or -r) is a hard scope: organizations
  // from the config file must not widen it back out.
  setScopedRepositories(repositories: string[]): void {
    this.config = { ...this.config, repositories, organizations: [] }
  }

  getConfig(): Config {
    return this.config
  }

  get repositories(): string[] {
    return this.config.repositories || []
  }

  get organizations(): string[] {
    return this.config.organizations || []
  }

  get refreshInterval(): number {
    return this.config.refreshInterval || 5000
  }

  get maxWorkflows(): number {
    return this.config.maxWorkflows || 20
  }

  get filterStatus(): string[] {
    return this.config.filterStatus || []
  }

  get showCompletedFor(): number {
    return this.config.showCompletedFor || 5
  }

  // Build final list of repositories from config and orgs
  async buildRepositoryList(
    githubService: GitHubService,
    dashboard?: Dashboard,
  ): Promise<string[]> {
    const repos = new Set<string>()

    // Add explicitly configured repositories
    for (const repo of this.repositories) {
      repos.add(repo)
    }

    // Add repositories from organizations with timeout protection
    for (const org of this.organizations) {
      try {
        if (dashboard) dashboard.log(`Fetching repositories for org: ${org}`, "debug")
        const orgRepos = await Promise.race([
          githubService.listRepositories(org),
          new Promise<Repository[]>((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 15000),
          ),
        ])
        for (const repo of orgRepos) {
          repos.add(repo.fullName)
        }
        if (dashboard) dashboard.log(`Found ${orgRepos.length} repos for ${org}`, "debug")
      } catch (_error) {
        if (dashboard) dashboard.log(`Failed to fetch repos for org ${org}`, "error")
        // Continue with other orgs
      }
    }

    // If no repos specified, try to use current directory's repo
    if (repos.size === 0) {
      const currentRepo = await resolveRepoAtPath(process.cwd())
      if (currentRepo) {
        if (dashboard) dashboard.log(`Using current repository: ${currentRepo}`, "info")
        repos.add(currentRepo)
      } else {
        // No repos found - dashboard will show empty state with instructions
        if (dashboard) dashboard.log("No repositories specified", "info")
      }
    }

    if (dashboard) dashboard.log(`Total repositories to monitor: ${repos.size}`, "info")
    return Array.from(repos)
  }
}
