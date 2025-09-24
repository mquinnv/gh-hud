import { execa } from "execa"
import { existsSync } from "fs"
import { join, dirname } from "path"
import type { DockerService, DockerServiceStatus } from "./types.js"

export class DockerServiceManager {
  private cache: Map<string, { data: DockerServiceStatus; timestamp: number }> = new Map()
  private cacheTimeout = 5000 // 5 seconds, same as GitHub service
  private dockerAvailable?: boolean

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
   * Get repository path from repo name (owner/repo format)
   */
  private async getRepoPath(repo: string): Promise<string | null> {
    try {
      // Try to get the current working directory's git remote
      const { stdout: currentRemote } = await execa("git", ["remote", "get-url", "origin"], { 
        timeout: 2000,
        reject: false 
      })
      
      // Check if current directory matches the repo
      if (currentRemote && currentRemote.includes(repo)) {
        const { stdout: gitRoot } = await execa("git", ["rev-parse", "--show-toplevel"], { timeout: 2000 })
        return gitRoot
      }
      
      // Try common project directories
      const homeDir = process.env.HOME || process.env.USERPROFILE || ""
      const possiblePaths = [
        join(homeDir, "Projects", repo.split("/")[1]),
        join(homeDir, "projects", repo.split("/")[1]),
        join(homeDir, "code", repo.split("/")[1]),
        join(homeDir, "Code", repo.split("/")[1]),
        join(homeDir, "src", repo.split("/")[1]),
        join(homeDir, "workspace", repo.split("/")[1]),
        join(process.cwd(), "..", repo.split("/")[1]),
      ]
      
      for (const path of possiblePaths) {
        if (existsSync(path)) {
          // Verify it's the right repo by checking git remote
          try {
            const { stdout } = await execa("git", ["remote", "get-url", "origin"], { 
              cwd: path,
              timeout: 2000,
              reject: false 
            })
            if (stdout && stdout.includes(repo)) {
              return path
            }
          } catch {
            // Not a git repo or wrong repo, continue
          }
        }
      }
      
      return null
    } catch {
      return null
    }
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
  async getAllDockerStatus(repos: string[]): Promise<DockerServiceStatus[]> {
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
      const repoPath = await this.getRepoPath(repo)
      
      if (!repoPath) {
        // Skip repos we can't find locally
        continue
      }
      
      const composeFiles = this.findComposeFiles(repoPath)
      
      for (const composeFile of composeFiles) {
        const status = await this.getComposeStatus(composeFile, repo)
        allStatuses.push(status)
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