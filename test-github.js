import { GitHubService } from "./dist/github.js"

const service = new GitHubService()

console.log("Testing phenixcrm/clean...")
const workflows = await service.listWorkflowRuns("phenixcrm/clean", 5)
console.log("Found workflows:", workflows.length)
workflows.forEach((w) => {
  console.log(`- ${w.workflowName}: ${w.status} (${w.conclusion || "running"})`)
})

console.log("\nGetting all active workflows...")
const active = await service.getAllActiveWorkflows(["phenixcrm/clean"])
console.log("Active workflows:", active.length)
active.forEach((w) => {
  console.log(`- ${w.repository.owner}/${w.repository.name} - ${w.workflowName}: ${w.status}`)
})
