import { readFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"
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
      } catch (error) {
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
  async buildRepositoryList(githubService: any): Promise<string[]> {
    const repos = new Set<string>()

    // Add explicitly configured repositories
    for (const repo of this.repositories) {
      repos.add(repo)
    }

    // Add repositories from organizations with timeout protection
    for (const org of this.organizations) {
      try {
        console.error(`Fetching repositories for org: ${org}`)
        const orgRepos = await Promise.race([
          githubService.listRepositories(org),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
        ])
        for (const repo of orgRepos) {
          repos.add(repo.fullName)
        }
        console.error(`Found ${orgRepos.length} repos for ${org}`)
      } catch (error) {
        console.error(`Failed to fetch repos for org ${org}:`, error)
        // Continue with other orgs
      }
    }

    // Only fetch all user repos if explicitly no config was provided anywhere
    // Commenting this out - users should explicitly specify what they want to monitor
    // if (repos.size === 0) {
    //   console.error("No repositories specified. Please specify repos with --repo or orgs with --org")
    // }

    console.error(`Total repositories to monitor: ${repos.size}`)
    return Array.from(repos)
  }
}
