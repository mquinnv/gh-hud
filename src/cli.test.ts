import { describe, expect, test } from "bun:test"
import { Command } from "commander"
import { execa } from "execa"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs"
import { createRequire } from "module"
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

  // Ruling 39: the flag advertised GitHub status names and no filter ever read it.
  test("-s/--status is no longer accepted", () => {
    for (const flag of ["--status", "-s"]) {
      const command = addWatchOptions(new Command())
        .exitOverride()
        .configureOutput({ writeErr: () => {}, writeOut: () => {} })
        .action(() => {})
      expect(() => command.parse([flag, "queued"], { from: "user" })).toThrow(/unknown option/)
    }
  })

  test("--pipeline collects one or more slugs", () => {
    const options = parseOptions(["--pipeline", "web", "api"])
    expect(options.pipeline).toEqual(["web", "api"])
  })
})

// A dev-path sanity check only — NOT the symlink regression test. Under
// `bun`, launching src/index.ts through a symlink does not reproduce the
// npm-.bin defect Ruling 28 fixed: Bun resolves process.argv[1] through the
// symlink to the same realpath fileURLToPath(import.meta.url) already
// resolves to, so even the old, buggy `argv[1] === fileURLToPath(...)`
// guard's comparison still matched under bun (confirmed by hand — see the
// task report). This only proves `bun src/index.ts` still works when
// symlinked, which is worth keeping as a smoke check of the dev workflow
// (`bun --watch src/index.ts` via a symlinked `.bin` shim, as `npm link`
// would produce locally). The real regression test is in the "npm bin
// symlink" describe block below.
describe("dev path (bun on source, sanity check only)", () => {
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
})

/**
 * The real node_modules directory that bare imports (`commander`, `blessed`,
 * `execa`, …) resolve to from this file's location — which may be several
 * directories above the repo root (this worktree has no `node_modules` of
 * its own; resolution climbs to the main checkout's). Used to give the
 * scratch build tree a `node_modules` that actually resolves, without
 * hardcoding or guessing the layout.
 */
function nodeModulesRootFor(pkgName: string): string {
  const require = createRequire(import.meta.url)
  const entry = require.resolve(pkgName)
  const marker = "/node_modules/"
  const idx = entry.lastIndexOf(marker)
  if (idx === -1) {
    throw new Error(`"${pkgName}" did not resolve through a node_modules directory: ${entry}`)
  }
  return entry.slice(0, idx + marker.length - 1)
}

describe("npm bin symlink", () => {
  // The real regression test. `node` — the shebang's and package.json bin's
  // interpreter — keeps process.argv[1] as the literal path it was invoked
  // with (the symlink), while fileURLToPath(import.meta.url) still resolves
  // to the realpath. Those two staying different is exactly what broke the
  // old guard, and is why Ruling 28 removed main-module detection instead of
  // patching the comparison (npx, Windows .cmd shims, and bun vs node all
  // differ here too).
  //
  // This compiles into a scratch directory rather than the repo's shared
  // `dist/` — a test must never rebuild (or depend on the freshness of) a
  // build artifact other tooling relies on. The scratch tree needs two
  // things a naive `--outDir` wouldn't give it: a `package.json` one level
  // above `dist/` (cli.ts reads the version from
  // `join(__dirname, "..", "package.json")`), and a `node_modules` that
  // resolves (Node walks up from the compiled file's REAL path to find
  // bare imports).
  test("the built CLI runs under node when launched through a symlink, as npm's .bin does", async () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url))
    const scratch = mkdtempSync(join(tmpdir(), "ops-hud-cli-build-"))
    const pkgDir = join(scratch, "pkg")
    const distDir = join(pkgDir, "dist")
    mkdirSync(pkgDir, { recursive: true })

    try {
      copyFileSync(join(repoRoot, "package.json"), join(pkgDir, "package.json"))
      symlinkSync(nodeModulesRootFor("commander"), join(pkgDir, "node_modules"))

      // Same interpreter `bun run build` uses to invoke `tsc`, just with an
      // explicit --outDir override so it never touches the repo's dist/.
      await execa("bun", ["run", "tsc", "--outDir", distDir], { cwd: repoRoot })

      const distIndexPath = join(distDir, "index.js")
      const linkDir = mkdtempSync(join(tmpdir(), "ops-hud-dist-symlink-test-"))
      const linkPath = join(linkDir, "ops-hud")
      symlinkSync(distIndexPath, linkPath)

      try {
        const { stdout } = await execa("node", [linkPath, "--help"])
        expect(stdout).toContain("Usage:")
      } finally {
        rmSync(linkDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 30000)
})
