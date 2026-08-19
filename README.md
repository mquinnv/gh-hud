# gh-hud

A terminal-based dashboard for monitoring GitHub Actions workflows across multiple repositories. Similar to `gh run watch` but displays multiple workflows simultaneously in a grid layout.

![GitHub Workflow Monitor](https://img.shields.io/badge/version-1.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 🎯 **Auto-Detection**: Automatically monitors the current directory's GitHub repository when run without arguments
- 📊 **Multi-Repository Monitoring**: Watch workflows from multiple repositories and organizations simultaneously
- 🔄 **Auto-Refresh**: Configurable refresh interval with smooth animated spinner
- 🎨 **Color-Coded Status**: Visual indicators for workflow status (running, success, failure, queued)
- ⌨️ **Keyboard Navigation**: Navigate between workflows using arrow keys or vim-style keys
- 📐 **Dynamic Layout**: Automatically adjusts grid layout based on terminal size and number of workflows
- 🔧 **Configurable**: Support for configuration files and command-line arguments
- 📦 **Job Details**: View individual job status and current running steps
- 📝 **Event Log**: Built-in event log with configurable log levels (INFO/DEBUG/TRACE)
- 💾 **Persistent Settings**: Remembers your preferences between sessions
- 📊 **Enhanced Status Bar**: Two-line status display with keyboard shortcuts reference
- 🔔 **Pull Request Monitoring**: Optional display of open pull requests (--show-prs flag)
- 🐳 **Docker Compose Monitoring**: Optional display of Docker service status (--show-docker flag)

## Prerequisites

- Node.js 18+ 
- `gh` CLI tool installed and authenticated
- GitHub access to repositories you want to monitor
- Docker (optional, required only for Docker service monitoring)

## Installation

### From npm (recommended)

```bash
npm install -g gh-hud
```

### From source

```bash
# Clone the repository
git clone https://github.com/mquinnv/gh-hud.git
cd gh-hud

# Install dependencies
bun install

# Build the project
bun run build

# Link globally (optional)
bun link
```

## Usage

### Basic Usage

When in a GitHub repository directory, monitor that repository:

```bash
gh-hud
```

Monitor specific repositories:

```bash
gh-hud --repo owner/repo1 owner/repo2
```

Or using the shorthand:

```bash
gh-hud -r owner/repo1 owner/repo2
```

Monitor whichever repository owns a given checkout, by path:

```bash
gh-hud .
gh-hud ~/Projects/remix
```

A path (like `--repo`) is a *hard* scope: organizations listed in your config
file are ignored for that run, so the dashboard shows exactly one repository.
This is what makes gh-hud useful as a per-project pane in a tmux split. If the
path isn't a directory, or has no `github.com` remote, gh-hud exits with an
error rather than starting an empty dashboard.

### Monitor Organization Repositories

```bash
gh-hud --org mquinnv --org phenixcrm
```

### Custom Refresh Interval

```bash
gh-hud --interval 10  # Refresh every 10 seconds
```

### Using Configuration File

```bash
gh-hud --config ~/.gh-hud.json
```

### Show Pull Requests

```bash
gh-hud --show-prs  # Display open PRs in header
```

### Show Docker Services

```bash
gh-hud --show-docker  # Display Docker Compose service status
gh-hud -d             # Short form
```

### Combined Features

```bash
gh-hud --show-prs --show-docker  # Show both PRs and Docker services
gh-hud -p -d                     # Short form
```

## Configuration

Create a `.gh-hud.json` file in your home directory or project root:

```json
{
  "repositories": [
    "owner/repo1",
    "owner/repo2"
  ],
  "organizations": [
    "mquinnv",
    "phenixcrm"
  ],
  "refreshInterval": 5000,
  "maxWorkflows": 20,
  "filterStatus": ["in_progress", "queued"],
  "showCompletedFor": 5
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repositories` | string[] | [] | Specific repositories to monitor |
| `organizations` | string[] | [] | Organizations to monitor |
| `refreshInterval` | number | 5000 | Refresh interval in milliseconds |
| `maxWorkflows` | number | 20 | Maximum number of workflows to display |
| `filterStatus` | string[] | ["in_progress", "queued"] | Filter workflows by status |
| `showCompletedFor` | number | 5 | Minutes to show completed workflows |

## Keyboard Shortcuts

### Navigation
| Key | Action |
|-----|--------|
| `↑` / `k` | Move selection up |
| `↓` / `j` | Move selection down |
| `←` / `h` | Move selection left |
| `→` / `l` | Move selection right |
| `Enter` | Open selected workflow in browser |
| `?` | Show help |
| `q` / `Ctrl+C` | Quit |

### Workflow Management
| Key | Action |
|-----|--------|
| `d` | Dismiss completed workflow |
| `D` | Dismiss ALL completed workflows |
| `r` | Force refresh |

### Event Log
| Key | Action |
|-----|--------|
| `F9` | Toggle event log visibility |
| `F10` | Cycle log level (INFO → DEBUG → TRACE) |
| `a` | Toggle auto-show on startup |
| `Ctrl+k` | Increase event log height |
| `Ctrl+d` | Decrease event log height |

## Status Indicators

### Workflow Status
- 🟡 **Yellow (●)**: Workflow is running
- 🟢 **Green (✓)**: Workflow completed successfully
- 🔴 **Red (✗)**: Workflow failed
- ⚪ **Gray (○)**: Workflow is queued
- ⚪ **Gray (⊘)**: Workflow was cancelled
- ⚪ **Gray (⊜)**: Workflow was skipped

### Docker Service Status
- 🟢 **Green (✓)**: Service is running and healthy
- 🟢 **Green (●)**: Service is running (no health check)
- 🟡 **Yellow (●)**: Service health is starting
- 🔴 **Red (✗)**: Service is unhealthy
- 🟡 **Yellow (↻)**: Service is restarting
- 🟡 **Yellow (⏸)**: Service is paused
- ⚪ **Gray (○)**: Service is stopped/exited

## Event Log

The built-in event log helps you track what's happening in your repositories:

- **INFO Level**: Shows important events like workflow status changes
- **DEBUG Level**: Includes refresh notifications and system messages
- **TRACE Level**: Shows all messages including detailed state updates

Press `F9` to toggle the event log, and `F10` to cycle through log levels. The log automatically filters messages based on your selected level. Your preferences (height, auto-show, log level) are saved between sessions.

## Docker Monitoring

The Docker monitoring feature shows the status of services defined in `docker-compose.yml` files in your monitored repositories. It automatically:

- Detects docker-compose files in repository roots
- Shows service health status if health checks are configured
- Displays exposed ports for each service
- Groups services by repository
- Updates status in real-time with the same refresh interval as workflows

**Note**: Docker must be installed and running on your system for this feature to work. The tool will gracefully handle cases where Docker is not available.

## Development

```bash
# Run in development mode
bun dev

# Build the project
bun run build

# Run linting
bun run lint

# Format code
bun run format
```

## Project Structure

```
gh-hud/
├── src/
│   ├── index.ts       # CLI entry point
│   ├── app.ts         # Main application logic
│   ├── dashboard.ts   # Terminal UI components
│   ├── github.ts      # GitHub API service
│   ├── config.ts      # Configuration management
│   └── types.ts       # TypeScript type definitions
├── bin/
│   └── gh-hud.js      # Executable script
├── package.json
├── tsconfig.json
├── biome.json
└── README.md
```

## Troubleshooting

### No workflows appearing

1. Ensure `gh` is authenticated: `gh auth status`
2. Check repository access: `gh repo list`
3. Verify workflows exist: `gh run list --repo owner/repo`

### Performance issues

- Reduce the number of monitored repositories
- Increase the refresh interval
- Use `filterStatus` to only show active workflows

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details

## Author

Michael Quinn

## Acknowledgments

- Built with [blessed](https://github.com/chjj/blessed) for terminal UI
- Uses GitHub CLI (`gh`) for API access
- Inspired by `gh run watch` command
