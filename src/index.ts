#!/usr/bin/env node

import { program } from "commander"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { App } from "./app.js"
import { resolveScope } from "./config.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"))

interface WatchOptions {
  repo?: string[]
  config?: string
  org?: string[]
  interval: string
  status?: string[]
  showPrs?: boolean
  showDocker?: boolean
}

async function watch(path: string | undefined, options: WatchOptions): Promise<void> {
  // Resolve the path scope before blessed takes the screen — an error raised
  // once the UI is up is an invisible empty dashboard.
  let scopedRepository: string | undefined
  let scopeDir: string | undefined
  if (path) {
    try {
      const scope = await resolveScope(path)
      scopedRepository = scope.repo
      scopeDir = scope.dir
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
      process.exit(1)
    }
  }

  const app = new App()

  try {
    await app.initialize({
      repositories: options.repo,
      config: options.config,
      organizations: options.org,
      interval: parseInt(options.interval, 10),
      showPRs: options.showPrs,
      showDocker: options.showDocker,
      scopedRepository,
      scopeDir,
    })
  } catch (error) {
    // Write to stderr in a way that won't interfere with the UI
    process.stderr.write(`Failed to initialize app: ${error}\n`)
    process.exit(1)
  }

  // Handle graceful shutdown
  const cleanup = () => {
    app.stop()
    process.exit(0)
  }

  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
  process.on("SIGUSR1", cleanup)
  process.on("SIGUSR2", cleanup)

  // Handle uncaught exceptions
  process.on("uncaughtException", (_error) => {
    // Don't output to console as it interferes with UI
    cleanup()
  })
}

// Both the bare invocation and the explicit `watch` subcommand take the same
// arguments, so register them from one place.
function addWatchOptions(command: typeof program): typeof program {
  return command
    .argument(
      "[path]",
      "Path to a checkout; monitors only that repository (e.g. '.' or ~/Projects/remix)",
    )
    .option("-r, --repo <repositories...>", "Specific repositories to watch (format: owner/repo)")
    .option("-c, --config <path>", "Path to configuration file")
    .option("-o, --org <organizations...>", "Organizations to monitor")
    .option("-i, --interval <seconds>", "Refresh interval in seconds", "5")
    .option("-s, --status <statuses...>", "Filter by status (queued, in_progress, completed)")
    .option("-p, --show-prs", "Show open pull requests in header")
    .option("-d, --show-docker", "Show Docker Compose service status in header")
    .action(watch)
}

program
  .name("gh-hud")
  .description("GitHub workflow monitoring dashboard for terminal")
  .version(packageJson.version)

addWatchOptions(program.command("watch").description("Watch GitHub workflows") as typeof program)

// Default command (same as watch)
addWatchOptions(program)

program.parse()
