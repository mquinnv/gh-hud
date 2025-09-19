#!/usr/bin/env bun

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
  .option("-p, --show-prs", "Show open pull requests in header")
  .action(async (options) => {
    const app = new App()

    try {
      await app.initialize({
        repositories: options.repo,
        config: options.config,
        organizations: options.org,
        interval: parseInt(options.interval, 10),
        showPRs: options.showPrs,
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
  })

// Default command (same as watch)
program
  .option("-r, --repo <repositories...>", "Specific repositories to watch (format: owner/repo)")
  .option("-c, --config <path>", "Path to configuration file")
  .option("-o, --org <organizations...>", "Organizations to monitor")
  .option("-i, --interval <seconds>", "Refresh interval in seconds", "5")
  .option("-s, --status <statuses...>", "Filter by status (queued, in_progress, completed)")
  .option("-p, --show-prs", "Show open pull requests in header")
  .action(async (options) => {
    const app = new App()

    try {
      await app.initialize({
        repositories: options.repo,
        config: options.config,
        organizations: options.org,
        interval: parseInt(options.interval, 10),
        showPRs: options.showPrs,
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
  })

program.parse()
