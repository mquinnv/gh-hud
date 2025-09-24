import { execa } from "execa"
import { existsSync } from "fs"
import { join, dirname } from "path"
import type { DockerService, DockerServiceStatus } from "./types.js"

export class DockerServiceManager {
  private cache: Map<string, { data: DockerServiceStatus; timestamp: number }> = new Map()
  private cacheTimeout = 5000 // 5 seconds, same as GitHub service
  private dockerAvailable?: boolean
  
  /**
   * Check if a git remote URL matches a repository
   */
  private remoteMatchesRepo(remoteUrl: string, repo: string): boolean {
    // Normalize the remote URL
    // Handle formats like:
    // - https://github.com/owner/repo.git
    // - git@github.com:owner/repo.git  
    // - gh:owner/repo
    const normalized = remoteUrl.toLowerCase().replace(/\.git$/, "")
    const repoLower = repo.toLowerCase()
    
    // Check if the remote contains the owner/repo pattern
    if (normalized.includes(repoLower)) {
      return true
    }
    
    // Also check if it contains owner:repo pattern (SSH format)
    const sshFormat = repoLower.replace("/", ":")
    if (normalized.includes(sshFormat)) {
      return true
    }
    
    return false
  }

  /**
   * Check if Docker is available on the system
   */
  private async checkDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== undefined) {
      return this.dockerAvailable
    }

    try {
      await execa("docker", ["version"], { timeout: 2000 })
      this.dockerAvailable = true
      return true
    } catch {
      this.dockerAvailable = false
      return false
    }
  }

  /**
   * Find docker-compose files in a repository
   */
  private findComposeFiles(repoPath: string): string[] {
    const composeFileNames = [
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml"
    ]
    
    const foundFiles: string[] = []
    
    for (const fileName of composeFileNames) {
      const filePath = join(repoPath, fileName)
      if (existsSync(filePath)) {
        foundFiles.push(filePath)
      }
    }
    
    return foundFiles
  }

  /**
   * Get all possible repository paths from repo name (owner/repo format)
   */
  private async getRepoPaths(repo: string): Promise<string[]> {
    const paths: string[] = []
    try {
      // Try to get the current working directory's git remote
      const { stdout: currentRemote } = await execa("git", ["remote", "get-url", "origin"], { 
        timeout: 2000,
        reject: false 
      })
      
      // Check if current directory matches the repo
      if (currentRemote && this.remoteMatchesRepo(currentRemote, repo)) {
        const { stdout: gitRoot } = await execa("git", ["rev-parse", "--show-toplevel"], { timeout: 2000 })
        paths.push(gitRoot)
      }
      
      // Try common project directories
      const homeDir = process.env.HOME || process.env.USERPROFILE || ""
      const repoName = repo.split("/")[1]
      const possiblePaths = [
        join(homeDir, "Projects", repoName),
        join(homeDir, "projects", repoName),
        join(homeDir, "code", repoName),
        join(homeDir, "Code", repoName),
        join(homeDir, "src", repoName),
        join(homeDir, "workspace", repoName),
        join(process.cwd(), "..", repoName),
        // Also try some common alternative folder names
        join(homeDir, "Projects", "phenix"), // Special case for phenixcrm/clean -> phenix
        join(homeDir, "Projects", "phenixcrm"),
      ]
      
      for (const path of possiblePaths) {
        if (existsSync(path)) {
          // Check if it has a docker-compose file first (faster check)
          const hasCompose = this.findComposeFiles(path).length > 0
          if (hasCompose) {
            // Verify it's the right repo by checking git remote
            try {
              const { stdout } = await execa("git", ["remote", "get-url", "origin"], { 
                cwd: path,
                timeout: 2000,
                reject: false 
              })
              if (stdout && this.remoteMatchesRepo(stdout, repo)) {
                paths.push(path)
              }
            } catch {
              // Not a git repo, but if it has docker-compose, might still be valid
              // Check if the path ends with expected repo name
              if (path.endsWith(repoName)) {
                paths.push(path)
              }
            }
          }
        }
      }
    } catch {
      // Ignore errors
    }
    
    return [...new Set(paths)] // Remove duplicates
  }

  /**
   * Parse docker compose ps output to extract service information
   */
  private parseDockerComposeOutput(output: string): DockerService[] {
    const services: DockerService[] = []
    const lines = output.split("\n").filter(line => line.trim())
    
    // Skip header line if present
    const startIndex = lines[0]?.includes("NAME") ? 1 : 0
    
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      
      // Docker compose v2 format: NAME IMAGE COMMAND SERVICE CREATED STATUS PORTS
      // Docker compose v1 format: Name Command State Ports
      const parts = line.split(/\s{2,}/).map(p => p.trim())
      
      if (parts.length >= 3) {
        // Try to detect format based on content
        const isV2 = parts.some(p => p.match(/^\d+\s+(second|minute|hour|day)s?\s+ago$/))
        
        if (isV2 && parts.length >= 6) {
          // V2 format
          const name = parts[0]
          const serviceName = parts[3] || name.split("-").slice(-1)[0]
          const status = parts[5] || "Unknown"
          const ports = parts[6] || ""
          
          const state = this.parseStateFromStatus(status)
          const health = this.parseHealthFromStatus(status)
          
          services.push({
            name: serviceName,
            containerName: name,
            state,
            status,
            health,
            ports: ports ? ports.split(", ") : []
          })
        } else {
          // V1 format or fallback
          const name = parts[0]
          const serviceName = name.split("_")[1] || name
          const status = parts[2] || parts[1] || "Unknown"
          const ports = parts[3] || parts[2] || ""
          
          const state = this.parseStateFromStatus(status)
          const health = this.parseHealthFromStatus(status)
          
          services.push({
            name: serviceName,
            containerName: name,
            state,
            status,
            health,
            ports: ports ? ports.split(", ") : []
          })
        }
      }
    }
    
    return services
  }

  /**
   * Parse state from status string
   */
  private parseStateFromStatus(status: string): DockerService["state"] {
    const statusLower = status.toLowerCase()
    
    if (statusLower.includes("up") || statusLower.includes("running")) {
      return "running"
    } else if (statusLower.includes("exited")) {
      return "exited"
    } else if (statusLower.includes("paused")) {
      return "paused"
    } else if (statusLower.includes("restarting")) {
      return "restarting"
    } else if (statusLower.includes("dead")) {
      return "dead"
    } else if (statusLower.includes("removing")) {
      return "removing"
    } else if (statusLower.includes("created")) {
      return "created"
    }
    
    return "exited" // Default to exited if unknown
  }

  /**
   * Parse health status from status string
   */
  private parseHealthFromStatus(status: string): DockerService["health"] {
    if (status.includes("(healthy)")) {
      return "healthy"
    } else if (status.includes("(unhealthy)")) {
      return "unhealthy"
    } else if (status.includes("(health: starting)")) {
      return "starting"
    }
    
    return "none"
  }

  /**
   * Get Docker service status for a compose file
   */
  private async getComposeStatus(composeFile: string, repo: string): Promise<DockerServiceStatus> {
    const cacheKey = `docker:${composeFile}`
    
    // Check cache
    const cached = this.getFromCache(cacheKey)
    if (cached) {
      return cached
    }
    
    try {
      const dir = dirname(composeFile)
      
      // Try docker compose v2 first, then fall back to docker-compose v1
      let output: string
      try {
        const result = await execa("docker", ["compose", "-f", composeFile, "ps"], {
          cwd: dir,
          timeout: 5000
        })
        output = result.stdout
      } catch {
        // Fallback to docker-compose v1
        const result = await execa("docker-compose", ["-f", composeFile, "ps"], {
          cwd: dir,
          timeout: 5000
        })
        output = result.stdout
      }
      
      const services = this.parseDockerComposeOutput(output)
      
      const status: DockerServiceStatus = {
        repository: repo,
        composeFile,
        services
      }
      
      this.setCache(cacheKey, status)
      return status
    } catch (error) {
      return {
        repository: repo,
        composeFile,
        services: [],
        error: error instanceof Error ? error.message : "Failed to get Docker status"
      }
    }
  }

  /**
   * Get Docker service status for all monitored repositories
   */
  async getAllDockerStatus(repos: string[], debug?: (msg: string) => void): Promise<DockerServiceStatus[]> {
    // Check if Docker is available
    const dockerAvailable = await this.checkDockerAvailable()
    if (!dockerAvailable) {
      return [{
        repository: "system",
        composeFile: "none",
        services: [],
        error: "Docker is not installed or not available"
      }]
    }
    
    const allStatuses: DockerServiceStatus[] = []
    
    for (const repo of repos) {
      if (debug) debug(`Checking Docker services for ${repo}...`)
      const repoPaths = await this.getRepoPaths(repo)
      
      if (repoPaths.length === 0) {
        if (debug) debug(`Could not find local path for ${repo}`)
        // Skip repos we can't find locally
        continue
      }
      
      // Try each possible path and use the one with running services
      for (const repoPath of repoPaths) {
        if (debug) debug(`Checking repo path: ${repoPath}`)
        const composeFiles = this.findComposeFiles(repoPath)
        
        if (composeFiles.length === 0) {
          if (debug) debug(`No docker-compose files found in ${repoPath}`)
          continue
        }
        
        for (const composeFile of composeFiles) {
          if (debug) debug(`Getting status for ${composeFile}`)
          const status = await this.getComposeStatus(composeFile, repo)
          if (status.error) {
            if (debug) debug(`Error getting status: ${status.error}`)
          } else {
            if (debug) debug(`Found ${status.services.length} services`)
          }
          
          // Only add if we found services or got an error (not just empty)
          if (status.services.length > 0 || status.error) {
            allStatuses.push(status)
          }
        }
      }
    }
    
    return allStatuses
  }

  /**
   * Get from cache if not expired
   */
  private getFromCache(key: string): DockerServiceStatus | null {
    const cached = this.cache.get(key)
    if (!cached) return null
    
    const now = Date.now()
    if (now - cached.timestamp > this.cacheTimeout) {
      this.cache.delete(key)
      return null
    }
    
    return cached.data
  }

  /**
   * Set cache entry
   */
  private setCache(key: string, data: DockerServiceStatus): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    })
  }

  /**
   * Clear all cache entries
   */
  clearCache(): void {
    this.cache.clear()
  }
}