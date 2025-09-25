# gh-hud TODO List

## Features

### Resurrect Dismissed Workflow Runs
- [ ] Add keybinding (maybe 'U' for "Undo dismiss" or 'h' for "history")
- [ ] Fetch the workflow run that occurred before the earliest currently displayed
- [ ] Show it in completed state as if never dismissed
- [ ] Repeated presses fetch progressively older runs
- [ ] Implementation approach:
  - Track the oldest run ID/timestamp currently displayed
  - Use `gh run list --limit 1 --created "<oldest_timestamp"` to fetch earlier run
  - Add to workflows array and re-render
  - Maybe show a message like "Fetched run from <time ago>"
  - Consider max limit to prevent fetching too many old runs

### Complete PR Action Handlers (app.ts)
- [ ] Implement PR merge execution (`gh pr merge --method`)
- [ ] Implement PR checkout (`gh pr checkout`)
- [ ] Implement PR diff display in scrollable box
- [ ] Implement PR ready/draft toggle (`gh pr ready` / `gh pr draft`)
- [ ] Add PR approve/unapprove actions

### Complete Workflow Action Handlers (app.ts)
- [ ] Implement workflow re-run (`gh run rerun`)
- [ ] Implement workflow logs display in scrollable box (`gh run view --log`)
- [ ] Add workflow artifact download (`gh run download`)
- [ ] Add workflow watch mode (`gh run watch`)

### Docker Improvements
- [ ] Better shell integration (pause blessed for interactive shell?)
- [ ] Show logs in scrollable box instead of event log
- [ ] Add docker compose up/down for entire stack
- [ ] Add container health check details
- [ ] Add resource usage stats (CPU/memory)

### Navigation Fixes
- [ ] Fix the navigation getting stuck issue
- [ ] Clean up duplicate navigation logic between keybindings and navigateGrid
- [ ] Make navigation wrap-around optional
- [ ] Add page up/down for large grids

### Visual Improvements
- [ ] Add loading spinners for async operations
- [ ] Show success/failure notifications for actions
- [ ] Add color themes support
- [ ] Make box sizes configurable
- [ ] Add compact mode for more workflows

### Performance
- [ ] Optimize rendering for large numbers of workflows
- [ ] Add lazy loading for job details
- [ ] Cache management improvements
- [ ] Reduce API calls with smarter caching

### Configuration
- [ ] Add config file for keybindings
- [ ] Save window layout preferences
- [ ] Add profiles for different project types
- [ ] Export/import settings

## Bugs to Fix
- [ ] Navigation sometimes gets stuck when switching between areas
- [ ] Screen flickers on some terminal emulators
- [ ] Long PR titles/branch names overflow
- [ ] Some emojis don't render correctly

## Nice to Have
- [ ] GitHub notifications integration
- [ ] Slack/Discord notifications for completed workflows
- [ ] Multiple repository groups/workspaces
- [ ] Filter workflows by branch/author/status
- [ ] Search functionality (/, like vim)
- [ ] Workflow statistics dashboard
- [ ] Time-based auto-dismiss (dismiss completed after X minutes)
- [ ] Sound effects for completion/failure
- [ ] ASCII art celebrations for successful deployments