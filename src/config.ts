import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { Config } from './types.js'

const DEFAULT_CONFIG: Config = {
  repositories: [],
  organizations: ['mquinnv', 'inetalliance', 'ameriglide', 'phenixcrm'],
  refreshInterval: 5000, // 5 seconds
  maxWorkflows: 20,
  filterStatus: ['in_progress', 'queued'],
  showCompletedFor: 5 // minutes
}

export class ConfigManager {
  private config: Config = { ...DEFAULT_CONFIG }
  
  async loadConfig(configPath?: string): Promise<Config> {
    const paths = [
      configPath,
      '.gh-hud.json',
      join(homedir(), '.gh-hud.json'),
      join(homedir(), '.config', 'gh-hud', 'config.json')
    ].filter(Boolean) as string[]

    for (const path of paths) {
      try {
        const content = await readFile(path, 'utf-8')
        const userConfig = JSON.parse(content)
        this.config = { ...DEFAULT_CONFIG, ...userConfig }
        console.log(`Loaded config from ${path}`)
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

    // Add repositories from organizations
    for (const org of this.organizations) {
      const orgRepos = await githubService.listRepositories(org)
      for (const repo of orgRepos) {
        repos.add(repo.fullName)
      }
    }

    // Also add user's personal repositories if no specific config
    if (repos.size === 0) {
      const userRepos = await githubService.listRepositories()
      for (const repo of userRepos) {
        repos.add(repo.fullName)
      }
    }

    return Array.from(repos)
  }
}
