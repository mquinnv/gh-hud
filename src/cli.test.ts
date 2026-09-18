import { describe, expect, test } from "bun:test"
import { Command } from "commander"
import { execa } from "execa"
import { mkdtempSync, rmSync, symlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { fileURLToPath } from "url"
import { addWatchOptions } from "./cli.js"

/**
 * Parses `args` against the real option definitions and returns whatever
 * commander handed the action — never invoking `watch()` itself, which
 * touches `gh`/git and the terminal. Confirms the parsed options object, per
 * commander's `--no-X` convention (`options.buildkite === false` /
 * `options.github === false`), not just what App ends up doing with them.
 */
function parseOptions(args: string[]): Record<string, unknown> {
  let captured: Record<string, unknown> = {}
  const command = addWatchOptions(new Command())
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

describe("npm bin symlink", () => {
  // npm installs a package's `bin` as a symlink (node_modules/.bin/, and the
  // global prefix's bin/). process.argv[1] is then the symlink path while
  // fileURLToPath(import.meta.url) is the resolved target — any comparison
  // between the two is a trap. index.ts must parse unconditionally, with no
  // main-module detection of any kind, so this has to work.
  //
  // Under `bun`, this specific defect does NOT reproduce: Bun resolves
  // process.argv[1] through the symlink to the same realpath
  // fileURLToPath(import.meta.url) already resolves to, so the old buggy
  // guard's comparison happens to still match. Confirmed by hand (see the
  // task report) — reintroducing the old `argv[1] === fileURLToPath(...)`
  // guard and rerunning this exact test still passes under bun. This test
  // is kept anyway as a sanity check for the bun/dev path (`bun
  // src/index.ts` works when symlinked), but it is NOT the regression test
  // for the reported defect — that's the one below, which runs the actual
  // shipped artifact through `node`, exactly as npm's installed `.bin`
  // shim does, and does fail against the old guard.
  test("the CLI source runs under bun when launched through a symlink", async () => {
    const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), "ops-hud-symlink-test-"))
    const linkPath = join(dir, "ops-hud")
    symlinkSync(indexPath, linkPath)

    try {
      const { stdout } = await execa("bun", [linkPath, "--help"])
      expect(stdout).toContain("Usage:")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The real regression test. `node` — the shebang's and package.json bin's
  // interpreter — keeps process.argv[1] as the literal path it was invoked
  // with (the symlink), while fileURLToPath(import.meta.url) still resolves
  // to the realpath. Those two staying different is exactly what broke the
  // old guard, and is why Ruling 28 removed main-module detection instead of
  // patching the comparison (npx, Windows .cmd shims, and bun vs node all
  // differ here too). This builds the real dist/index.js first so the test
  // exercises the actual shipped artifact, not a stand-in.
  test("the built CLI runs under node when launched through a symlink, as npm's .bin does", async () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url))
    await execa("bun", ["run", "build"], { cwd: repoRoot })

    const distIndexPath = fileURLToPath(new URL("../dist/index.js", import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), "ops-hud-dist-symlink-test-"))
    const linkPath = join(dir, "ops-hud")
    symlinkSync(distIndexPath, linkPath)

    try {
      const { stdout } = await execa("node", [linkPath, "--help"])
      expect(stdout).toContain("Usage:")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})
