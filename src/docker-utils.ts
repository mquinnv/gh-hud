import { execa } from "execa"
import { existsSync } from "fs"
import { dirname, join } from "path"
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
    // - https://github.com/owner/repo
    const normalized = remoteUrl
      .toLowerCase()
      .replace(/\.git$/, "")
      .trim()
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

    // Extract repo name from URL and compare
    // Handle both HTTPS and SSH formats
    const urlMatch = normalized.match(/(?:github\.com[:/])([^/]+\/[^/.]+)/)
    if (urlMatch && urlMatch[1] === repoLower) {
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
      "compose.yaml",
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
  private async getRepoPaths(repo: string, debug?: (msg: string) => void): Promise<string[]> {
    const paths: string[] = []
    if (debug) debug(`Looking for repository: ${repo}`)

    try {
      // Try to get the current working directory's git remote
      const { stdout: currentRemote } = await execa("git", ["remote", "get-url", "origin"], {
        timeout: 2000,
        reject: false,
      })

      // Check if current directory matches the repo
      if (currentRemote && this.remoteMatchesRepo(currentRemote, repo)) {
        const { stdout: gitRoot } = await execa("git", ["rev-parse", "--show-toplevel"], {
          timeout: 2000,
        })
        paths.push(gitRoot)
        if (debug) debug(`Found in current directory: ${gitRoot}`)
      }

      // Try common project directories
      const homeDir = process.env.HOME || process.env.USERPROFILE || ""
      const [owner, repoName] = repo.split("/")

      // Build a more comprehensive list of possible paths
      const projectDirs = [
        join(homeDir, "Projects"),
        join(homeDir, "projects"),
        join(homeDir, "code"),
        join(homeDir, "Code"),
        join(homeDir, "src"),
        join(homeDir, "workspace"),
        join(process.cwd(), ".."),
      ]

      // For each project directory, scan for directories with docker-compose files
      for (const projectDir of projectDirs) {
        if (!existsSync(projectDir)) continue

        // Check for exact repo name match
        const exactPath = join(projectDir, repoName)
        if (existsSync(exactPath)) {
          const hasCompose = this.findComposeFiles(exactPath).length > 0
          if (hasCompose) {
            // Verify it's the right repo by checking git remote
            try {
              const { stdout } = await execa("git", ["remote", "get-url", "origin"], {
                cwd: exactPath,
                timeout: 2000,
                reject: false,
              })
              if (stdout && this.remoteMatchesRepo(stdout, repo)) {
                paths.push(exactPath)
                if (debug) debug(`Found at: ${exactPath}`)
              }
            } catch {
              // Not a git repo, but might still be valid
              if (debug) debug(`Found docker-compose but no git repo at: ${exactPath}`)
            }
          }
        }

        // Also scan all subdirectories for repositories that match
        try {
          const { stdout: dirs } = await execa("ls", ["-1", projectDir], {
            timeout: 2000,
          })

          const dirList = dirs.split("\n").filter((d) => d.trim())
          for (const dir of dirList) {
            const fullPath = join(projectDir, dir)

            // Skip if not a directory
            if (!existsSync(fullPath)) continue

            // Check if it has docker-compose files
            const hasCompose = this.findComposeFiles(fullPath).length > 0
            if (!hasCompose) continue

            // Check git remote
            try {
              const { stdout } = await execa("git", ["remote", "get-url", "origin"], {
                cwd: fullPath,
                timeout: 2000,
                reject: false,
              })

              if (stdout && this.remoteMatchesRepo(stdout, repo)) {
                paths.push(fullPath)
                if (debug) debug(`Found matching repo at: ${fullPath}`)
              }
            } catch {
              // Not a git repo or error getting remote
              // If the directory name is related to the repo name, might still include it
              const dirLower = dir.toLowerCase()
              const repoLower = repoName.toLowerCase()
              const ownerLower = owner.toLowerCase()

              if (dirLower.includes(repoLower) || dirLower.includes(ownerLower)) {
                if (debug) debug(`Found possible match (no git) at: ${fullPath}`)
                // We'll include it but with lower priority
              }
            }
          }
        } catch {
          // Error scanning directory
        }
      }
    } catch (error) {
      if (debug) debug(`Error in getRepoPaths: ${error}`)
    }

    const uniquePaths = [...new Set(paths)]
    if (debug && uniquePaths.length === 0) {
      debug(`No local paths found for repository: ${repo}`)
    }
    return uniquePaths
  }

  /**
   * Parse docker compose ps output to extract service information
   */
  private parseDockerComposeOutput(output: string): DockerService[] {
    const services: DockerService[] = []
    const lines = output.split("\n").filter((line) => line.trim())

    // Skip header line if present
    const startIndex = lines[0]?.includes("NAME") ? 1 : 0

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue

      // Docker compose v2 format: NAME IMAGE COMMAND SERVICE CREATED STATUS PORTS
      // Docker compose v1 format: Name Command State Ports
      const parts = line.split(/\s{2,}/).map((p) => p.trim())

      if (parts.length >= 3) {
        // Try to detect format based on content
        const isV2 = parts.some((p) => p.match(/^\d+\s+(second|minute|hour|day)s?\s+ago$/))

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
            ports: ports ? ports.split(", ") : [],
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
            ports: ports ? ports.split(", ") : [],
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
  private async getComposeStatus(
    composeFile: string,
    _repo: string,
    workingDir: string,
  ): Promise<DockerServiceStatus> {
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
        const result = await execa("docker", ["compose", "-f", composeFile, "ps", "-a"], {
          cwd: dir,
          timeout: 5000,
        })
        output = result.stdout
      } catch {
        // Fallback to docker-compose v1
        const result = await execa("docker-compose", ["-f", composeFile, "ps", "-a"], {
          cwd: dir,
          timeout: 5000,
        })
        output = result.stdout
      }

      const services = this.parseDockerComposeOutput(output)

      // Use working directory name instead of repo name
      const status: DockerServiceStatus = {
        repository: workingDir, // Use the actual directory name
        composeFile,
        services,
      }

      this.setCache(cacheKey, status)
      return status
    } catch (error) {
      return {
        repository: workingDir, // Use the actual directory name
        composeFile,
        services: [],
        error: error instanceof Error ? error.message : "Failed to get Docker status",
      }
    }
  }

  /**
   * Get Docker service status for all monitored repositories
   */
  async getAllDockerStatus(
    repos: string[],
    debug?: (msg: string) => void,
  ): Promise<DockerServiceStatus[]> {
    // Check if Docker is available
    const dockerAvailable = await this.checkDockerAvailable()
    if (!dockerAvailable) {
      return [
        {
          repository: "system",
          composeFile: "none",
          services: [],
          error: "Docker is not installed or not available",
        },
      ]
    }

    const allStatuses: DockerServiceStatus[] = []
    const processedComposeFiles = new Set<string>() // Track processed compose files to avoid duplicates

    for (const repo of repos) {
      if (debug) debug(`Checking Docker services for ${repo}...`)
      const repoPaths = await this.getRepoPaths(repo, debug)

      if (repoPaths.length === 0) {
        if (debug) debug(`Could not find local path for ${repo}`)
        // Skip repos we can't find locally
        continue
      }

      // Track if we've found services for this repo
      let foundServicesForRepo = false

      // Try each possible path but stop once we find services
      for (const repoPath of repoPaths) {
        if (foundServicesForRepo) {
          if (debug) debug(`Already found services for ${repo}, skipping ${repoPath}`)
          break
        }

        if (debug) debug(`Checking repo path: ${repoPath}`)
        const composeFiles = this.findComposeFiles(repoPath)

        if (composeFiles.length === 0) {
          if (debug) debug(`No docker-compose files found in ${repoPath}`)
          continue
        }

        // Get the actual working directory name (last part of path)
        const workingDirName = repoPath.split("/").pop() || repo

        for (const composeFile of composeFiles) {
          // Skip if we've already processed this exact compose file
          if (processedComposeFiles.has(composeFile)) {
            if (debug) debug(`Already processed ${composeFile}, skipping`)
            continue
          }

          if (debug) debug(`Getting status for ${composeFile}`)
          const status = await this.getComposeStatus(composeFile, repo, workingDirName)
          if (status.error) {
            if (debug) debug(`Error getting status: ${status.error}`)
          } else {
            if (debug) debug(`Found ${status.services.length} services`)
          }

          // Only add if we found services or got an error (not just empty)
          if (status.services.length > 0 || status.error) {
            allStatuses.push(status)
            processedComposeFiles.add(composeFile)

            // Mark that we found services for this repo
            if (status.services.length > 0) {
              foundServicesForRepo = true
            }
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
      timestamp: Date.now(),
    })
  }

  /**
   * Clear all cache entries
   */
  clearCache(): void {
    this.cache.clear()
  }
}
