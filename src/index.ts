#!/usr/bin/env node

import { program } from 'commander'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { App } from './app.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))

program
  .name('gh-hud')
  .description('GitHub workflow monitoring dashboard for terminal')
  .version(packageJson.version)

program
  .command('watch')
  .description('Watch GitHub workflows')
  .argument('[repositories...]', 'Specific repositories to watch (format: owner/repo)')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-o, --org <organizations...>', 'Organizations to monitor')
  .option('-i, --interval <seconds>', 'Refresh interval in seconds', '5')
  .option('-s, --status <statuses...>', 'Filter by status (queued, in_progress, completed)')
  .action(async (repositories, options) => {
    const app = new App()
    
    try {
      await app.initialize({
        repositories,
        config: options.config,
        organizations: options.org,
        interval: parseInt(options.interval)
      })
    } catch (error) {
      console.error('Failed to initialize app:', error)
      process.exit(1)
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      app.stop()
      process.exit(0)
    })

    process.on('SIGTERM', () => {
      app.stop()
      process.exit(0)
    })
  })

// Default command (same as watch)
program
  .argument('[repositories...]', 'Specific repositories to watch (format: owner/repo)')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-o, --org <organizations...>', 'Organizations to monitor')
  .option('-i, --interval <seconds>', 'Refresh interval in seconds', '5')
  .option('-s, --status <statuses...>', 'Filter by status (queued, in_progress, completed)')
  .action(async (repositories, options) => {
    const app = new App()
    
    try {
      await app.initialize({
        repositories,
        config: options.config,
        organizations: options.org,
        interval: parseInt(options.interval)
      })
    } catch (error) {
      console.error('Failed to initialize app:', error)
      process.exit(1)
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      app.stop()
      process.exit(0)
    })

    process.on('SIGTERM', () => {
      app.stop()
      process.exit(0)
    })
  })

program.parse()
