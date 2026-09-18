import { describe, expect, test } from "bun:test"
import { Command } from "commander"
import { addWatchOptions } from "./index.js"

/**
 * Parses `args` against the real option definitions and returns whatever
 * commander handed the action — never invoking `watch()` itself, which
 * touches `gh`/git and the terminal. Confirms the parsed options object, per
 * commander's `--no-X` convention (`options.buildkite === false` /
 * `options.github === false`), not just what App ends up doing with them.
 */
function parseOptions(args: string[]): Record<string, unknown> {
  let captured: Record<string, unknown> = {}
  const command = addWatchOptions(new Command() as unknown as Parameters<typeof addWatchOptions>[0])
  command.action((_path: unknown, options: Record<string, unknown>) => {
    captured = options
  })
  command.parse(args, { from: "user" })
  return captured
}

describe("CLI flags", () => {
  test("neither --no-buildkite nor --no-github is set by default", () => {
    const options = parseOptions([])
    expect(options.buildkite).toBe(true)
    expect(options.github).toBe(true)
  })

  test("--no-buildkite sets options.buildkite to false", () => {
    const options = parseOptions(["--no-buildkite"])
    expect(options.buildkite).toBe(false)
  })

  test("--no-github sets options.github to false", () => {
    const options = parseOptions(["--no-github"])
    expect(options.github).toBe(false)
  })

  test("--bk-org is parsed", () => {
    const options = parseOptions(["--bk-org", "acme"])
    expect(options.bkOrg).toBe("acme")
  })

  test("--pipeline collects one or more slugs", () => {
    const options = parseOptions(["--pipeline", "web", "api"])
    expect(options.pipeline).toEqual(["web", "api"])
  })
})
