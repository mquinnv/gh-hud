import { describe, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { DockerServiceManager } from "./docker-utils.js"

describe("repository path discovery", () => {
  test("uses the scoped checkout instead of guessing at project roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ops-hud-docker-"))
    const docker = new DockerServiceManager()
    docker.setScopeDir(dir)

    expect(await docker.getRepoPaths("acme/widgets")).toEqual([dir])
  })
})
