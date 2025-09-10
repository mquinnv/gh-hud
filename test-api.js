#!/usr/bin/env node

import { GitHubService } from './dist/github.js'
import { ConfigManager } from './dist/config.js'

async function testAPI() {
  console.log('Testing GitHub API...')
  
  const githubService = new GitHubService()
  const configManager = new ConfigManager()
  
  try {
    // Load config
    console.log('Loading config...')
    await configManager.loadConfig()
    
    console.log('Organizations:', configManager.organizations)
    
    // Test repository listing for each org
    for (const org of configManager.organizations) {
      console.log(`\nTesting repos for org: ${org}`)
      try {
        const repos = await githubService.listRepositories(org)
        console.log(`Found ${repos.length} repositories for ${org}:`)
        repos.slice(0, 3).forEach(repo => {
          console.log(`  - ${repo.fullName}`)
        })
      } catch (error) {
        console.error(`Error for org ${org}:`, error.message)
      }
    }
    
    // Build full repository list
    console.log('\nBuilding full repository list...')
    const allRepos = await configManager.buildRepositoryList(githubService)
    console.log(`Total repositories: ${allRepos.length}`)
    
    // Test workflow runs for first repo
    if (allRepos.length > 0) {
      const firstRepo = allRepos[0]
      console.log(`\nTesting workflow runs for: ${firstRepo}`)
      const runs = await githubService.listWorkflowRuns(firstRepo, 5)
      console.log(`Found ${runs.length} workflow runs`)
      runs.forEach(run => {
        console.log(`  - ${run.workflowName}: ${run.status} (${run.headBranch})`)
      })
    }
    
  } catch (error) {
    console.error('API Test failed:', error)
  }
}

testAPI()
