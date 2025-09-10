# gh-hud

A terminal-based dashboard for monitoring GitHub Actions workflows across multiple repositories. Similar to `gh run watch` but displays multiple workflows simultaneously in a grid layout.

![GitHub Workflow Monitor](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 📊 **Multi-Repository Monitoring**: Watch workflows from multiple repositories and organizations simultaneously
- 🔄 **Auto-Refresh**: Configurable refresh interval to keep workflow status up-to-date
- 🎨 **Color-Coded Status**: Visual indicators for workflow status (running, success, failure, queued)
- ⌨️ **Keyboard Navigation**: Navigate between workflows, refresh manually, and open in browser
- 📐 **Dynamic Layout**: Automatically adjusts grid layout based on terminal size and number of workflows
- 🔧 **Configurable**: Support for configuration files and command-line arguments
- 📦 **Job Details**: View individual job status and current running steps

## Prerequisites

- Node.js 18+ 
- `gh` CLI tool installed and authenticated
- GitHub access to repositories you want to monitor

## Installation

```bash
# Clone the repository
git clone https://github.com/mquinnv/gh-hud.git
cd gh-hud

# Install dependencies
pnpm install

# Build the project
pnpm build

# Link globally (optional)
pnpm link --global
```

## Usage

### Basic Usage

Monitor all repositories from your default organizations:

```bash
gh-hud
```

### Monitor Specific Repositories

```bash
gh-hud mquinnv/gh-hud phenixcrm/phenixcrm
```

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
| `organizations` | string[] | ["mquinnv", "inetalliance", "ameriglide", "phenixcrm"] | Organizations to monitor |
| `refreshInterval` | number | 5000 | Refresh interval in milliseconds |
| `maxWorkflows` | number | 20 | Maximum number of workflows to display |
| `filterStatus` | string[] | ["in_progress", "queued"] | Filter workflows by status |
| `showCompletedFor` | number | 5 | Minutes to show completed workflows |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` / `k` | Move selection up |
| `↓` / `j` | Move selection down |
| `Enter` | Open selected workflow in browser |
| `r` | Force refresh |
| `h` / `?` | Show help |
| `q` / `Ctrl+C` | Quit |

## Status Indicators

- 🟡 **Yellow (●)**: Workflow is running
- 🟢 **Green (✓)**: Workflow completed successfully
- 🔴 **Red (✗)**: Workflow failed
- ⚪ **Gray (○)**: Workflow is queued
- ⚪ **Gray (⊘)**: Workflow was cancelled
- ⚪ **Gray (⊜)**: Workflow was skipped

## Development

```bash
# Run in development mode
pnpm dev

# Build the project
pnpm build

# Run linting
pnpm lint

# Format code
pnpm format
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
