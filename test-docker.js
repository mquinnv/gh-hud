#!/usr/bin/env bun

import { DockerServiceManager } from "./dist/docker-utils.js"

async function test() {
  const docker = new DockerServiceManager()
  
  console.log("Testing Docker service detection...")
  
  // Test with phenixcrm/clean
  const services = await docker.getAllDockerStatus(
    ["phenixcrm/clean"],
    (msg) => console.log("DEBUG:", msg)
  )
  
  console.log("\nResults:")
  console.log(JSON.stringify(services, null, 2))
}

test().catch(console.error)