import { execa } from "execa"
import { readFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"
import type { Dashboard } from "./dashboard.js"
import type { Config } from "./types.js"

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

  // Try to detect the current directory's GitHub repository
  private async getCurrentRepo(): Promise<string | null> {
    try {
      // Check if we're in a git repository
      await execa("git", ["rev-parse", "--git-dir"])

      // Get the GitHub remote URL
      const { stdout } = await execa("git", ["remote", "get-url", "origin"])

      // Parse GitHub repo from URL
      // Handles: https://github.com/owner/repo.git
      //          git@github.com:owner/repo.git
      //          gh:owner/repo
      const match = stdout.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/)
      if (match) {
        return match[1]
      }

      return null
    } catch {
      return null
    }
  }

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
  async buildRepositoryList(githubService: any, dashboard?: Dashboard): Promise<string[]> {
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
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
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
      const currentRepo = await this.getCurrentRepo()
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
