#!/usr/bin/env node

import { program } from "commander"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { App } from "./app.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"))

program
  .name("gh-hud")
  .description("GitHub workflow monitoring dashboard for terminal")
  .version(packageJson.version)

program
  .command("watch")
  .description("Watch GitHub workflows")
  .option("-r, --repo <repositories...>", "Specific repositories to watch (format: owner/repo)")
  .option("-c, --config <path>", "Path to configuration file")
  .option("-o, --org <organizations...>", "Organizations to monitor")
  .option("-i, --interval <seconds>", "Refresh interval in seconds", "5")
  .option("-s, --status <statuses...>", "Filter by status (queued, in_progress, completed)")
  .action(async (options) => {
    const app = new App()

    try {
      await app.initialize({
        repositories: options.repo,
        config: options.config,
        organizations: options.org,
        interval: parseInt(options.interval, 10),
      })
    } catch (error) {
      console.error("Failed to initialize app:", error)
      process.exit(1)
    }

    // Handle graceful shutdown
    const cleanup = () => {
      console.error("\nShutting down...")
      app.stop()
      process.exit(0)
    }

    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)
    process.on("SIGUSR1", cleanup)
    process.on("SIGUSR2", cleanup)

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      console.error("Uncaught exception:", error)
      cleanup()
    })
  })

// Default command (same as watch)
program
  .option("-r, --repo <repositories...>", "Specific repositories to watch (format: owner/repo)")
  .option("-c, --config <path>", "Path to configuration file")
  .option("-o, --org <organizations...>", "Organizations to monitor")
  .option("-i, --interval <seconds>", "Refresh interval in seconds", "5")
  .option("-s, --status <statuses...>", "Filter by status (queued, in_progress, completed)")
  .action(async (options) => {
    const app = new App()

    try {
      await app.initialize({
        repositories: options.repo,
        config: options.config,
        organizations: options.org,
        interval: parseInt(options.interval, 10),
      })
    } catch (error) {
      console.error("Failed to initialize app:", error)
      process.exit(1)
    }

    // Handle graceful shutdown
    const cleanup = () => {
      console.error("\nShutting down...")
      app.stop()
      process.exit(0)
    }

    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)
    process.on("SIGUSR1", cleanup)
    process.on("SIGUSR2", cleanup)

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      console.error("Uncaught exception:", error)
      cleanup()
    })
  })

program.parse()
