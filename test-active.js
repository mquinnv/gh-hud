import { GitHubService } from './dist/github.js'

const gh = new GitHubService()
const runs = await gh.listWorkflowRuns('inetalliance/usm', 10)
console.log('Workflow runs for inetalliance/usm:', runs.length)
runs.forEach(run => console.log(`  - ${run.workflowName}: ${run.status} (${run.conclusion || 'no conclusion'})`))

const active = await gh.getAllActiveWorkflows(['inetalliance/usm'])
console.log('Active workflows:', active.length)
