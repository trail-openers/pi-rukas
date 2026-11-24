#!/usr/bin/env bun
/**
 * #2611 — the explore re-ask's CHILD: how it is assembled, and what is allowed
 * to answer.
 *
 * `test-work-driver-explore-reask.ts` pins the step's behaviour through the
 * injected seam, so nothing there ever assembles a child. These cases drive the
 * production builders — the argv, the bound, the env, and the settle that turns
 * a stream into an answer — without a live `pi` (case (5) launches a shell stub
 * as the child; no `pi` is spawned anywhere, and `assertLiveSpawnAllowed` would
 * refuse one offline).
 *
 * The row that decides this file exists (review of PR #2614, HIGH): the env the
 * re-ask child runs with. It used to be built with `forgeReadChildEnv` alone,
 * which stamps NONE of `PI_ENSEMBLE_ROLE`, the per-child `PI_ENSEMBLE_CHILD_TMP`
 * or the read-only role's scratch `HOME`/XDG — so every role-scoped child-side
 * rule (the #1879 read-only dependency rule, the #2200 deletion roots, the
 * #2140 reviewer bash bound, #2352's reviewer write guard) was inert for this
 * child while the same role's normal dispatch was judged by all of them. The
 * fix is to call the ONE builder the spawn path calls, and the pin below is
 * made on the child that actually ran: a stub records its own env, which is the
 * only reading that cannot be satisfied by a builder nobody calls.
 *
 * Style mirrors `test-adversarial-verdict-reask-child.ts` (the sibling re-ask)
 * and `test-adversarial-verdict-reask-spawn.ts` (the stage: a session file that
 * exists, a stub `pi`, one recorded invocation).
 */

// Must stay first: points the role prompts at a test-owned dir before src/roles.ts
// resolves them at module load (same helper as test-child-forge-credentials.ts).
import "./lib/cancel-prompts.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHILD_ROLE_ENV } from "../src/child-role-env.ts";
import { _resetPiBinaryCache } from "../src/pi-binary-resolve.ts";
import {
  exploreReaskBoundMs,
  exploreReaskChildArgs,
  spawnExploreReaskChild,
} from "../src/work-driver-explore-reask.ts";
import { CHILD_TMP_ENV } from "../src/write-fence-deletion.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const dir = mkdtempSync(path.join(tmpdir(), "explore-reask-child-"));
const MISSING_SESSION = path.join(dir, "no-session.json");
const SESSION = path.join(dir, "explore-session.json");
writeFileSync(SESSION, '{"type":"session"}\n');
/** The explore child's own tree — distinct from this process's cwd. */
const TREE = path.join(dir, "worktree");
mkdirSync(TREE, { recursive: true });

const ASK = {
  transcriptPath: SESSION,
  role: "explore",
  cwd: TREE,
  boundMs: 4_000,
  prompt: "reply with the verdict line and the spec",
};

/** One `agent_end` carrying one assistant reply — the stream shape the reader takes. */
function agentEnd(text: string): string {
  return JSON.stringify({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  });
}

/** Where the stub copies its own 0700 temp root while it is still alive (the ask
 * removes the original the instant the child settles). */
const snapshots = path.join(dir, "child-tmp-snapshots");
mkdirSync(snapshots, { recursive: true });

/**
 * Install a stub `pi` that records its own argv/cwd/env, copies its own temp root
 * out of the way before the parent removes it, prints `lines`, then either exits
 * or lingers past the ask's bound.
 *
 * The linger is a `sleep` longer than any bound these cases use, so a broken
 * bound shows up as a failing case rather than a hung suite — and the child's
 * own SIGTERM/SIGKILL (the ask's `finish`) is what ends it.
 */
function installStubPi(opts: { lines: string[]; lingerMs: number }): string {
  const stub = path.join(dir, "pi-stub.sh");
  const argvFile = path.join(dir, "argv.txt");
  const cwdFile = path.join(dir, "cwd.txt");
  const envFile = path.join(dir, "env.txt");
  const stdoutFile = path.join(dir, "stdout.txt");
  rmSync(argvFile, { force: true });
  rmSync(cwdFile, { force: true });
  rmSync(envFile, { force: true });
  rmSync(stdoutFile, { force: true });
  rmSync(path.join(snapshots, "latest"), { recursive: true, force: true });
  const script = [
    "#!/bin/sh",
    `[ "$1" = "--version" ] && { echo 1.4.0; exit 0; }`,
    `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)};`,
    `pwd > ${JSON.stringify(cwdFile)};`,
    `printenv > ${JSON.stringify(envFile)};`,
    // The ask removes this child's temp root when it settles, so anything the
    // assertions want to see inside it has to be copied out by the child itself.
    // The copy lands in `snapshots/latest`, and its basename is printed so the
    // parent can join it back to the per-child dir the child was handed.
    `echo SNAPSHOT=$(basename "$TMPDIR")`,
    `[ -n "$TMPDIR" ] && rm -rf ${JSON.stringify(path.join(snapshots, "latest"))} && cp -R "$TMPDIR" ${JSON.stringify(path.join(snapshots, "latest"))} 2>/dev/null;`,
    ...opts.lines.map(
      (line) => `printf '%s\\n' ${JSON.stringify(line)} | tee -a ${JSON.stringify(stdoutFile)}`,
    ),
    ...(opts.lingerMs > 0 ? [`sleep ${Math.ceil(opts.lingerMs / 1000)}`] : []),
    "",
  ].join("\n");
  writeFileSync(stub, script, { mode: 0o755 });
  chmodSync(stub, 0o755);
  // Named in the SAME env scope as the ask that must use it — a bare
  // `process.env` write would outlive the block and leave a later case talking
  // to a stub scripted for someone else.
  process.env.PI_ENSEMBLE_PI_BIN = stub;
  _resetPiBinaryCache();
  return stub;
}

/** What the last stub child recorded, or empty values when none ran. */
function readRecorded(): {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdout: string;
} {
  const read = (file: string): string => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  const env: Record<string, string> = {};
  for (const line of read(path.join(dir, "env.txt")).split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return {
    argv: read(path.join(dir, "argv.txt"))
      .split("\n")
      .filter((l) => l !== ""),
    cwd: read(path.join(dir, "cwd.txt")).trim(),
    env,
    stdout: read(path.join(dir, "stdout.txt")),
  };
}

try {
  // ── (1) the child's argv: a follow-up on one session, with no way to write ──
  {
    const argv = exploreReaskChildArgs({
      transcriptPath: SESSION,
      role: "explore",
      promptFile: "/tmp/pi-rukas-reask-abc/explore.md",
      model: "explore-model-1",
      provider: "openrouter",
    });
    const at = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
    assert(
      at("--session") === SESSION,
      `(1) it resumes the explore child's OWN session file (${String(at("--session"))})`,
    );
    assert(
      at("--mode") === "rpc",
      `(1) it speaks the RPC stream the reply reader parses (${String(at("--mode"))})`,
    );
    assert(
      argv.includes("--no-extensions") && argv.includes("-e") && argv.includes("builtin:mcp"),
      "(1) discovered extensions are off with only the MCP built-in re-enabled",
    );
    assert(
      at("--append-system-prompt") === "/tmp/pi-rukas-reask-abc/explore.md",
      `(1) configured with explore's own system prompt (${String(at("--append-system-prompt"))})`,
    );
    const excluded = (at("--exclude-tools") ?? "").split(",");
    assert(
      excluded.length === 3 && ["write", "edit", "multiedit"].every((t) => excluded.includes(t)),
      `(1) the explore tool fence is present so the asked child cannot re-do the investigation: --exclude-tools ${String(at("--exclude-tools"))}`,
    );
    const guards = argv[argv.indexOf("--extension") + 1];
    assert(
      argv.includes("--extension") && (guards ?? "").includes("child-guards"),
      `(1) the mode-independent child guards are loaded (${String(guards)})`,
    );
    assert(
      !argv.includes("--skill") && !argv.some((a) => a.includes("--skill")),
      "(1) no skill: a skill would re-run the investigation instead of answering",
    );
    assert(
      at("--model") === "explore-model-1" && at("--provider") === "openrouter",
      "(1) same model and provider as the dispatch it follows up — otherwise a second opinion",
    );
  }

  // ── (2) the bound: default, override, and reject-to-default ────────────────
  for (const [value, want] of [
    [undefined, 180_000],
    ["60000", 60_000],
    // A bound of zero or less would kill the child the instant it started, so
    // an unreadable value is a mistake, not a request — and a mistake gets the
    // shipped default rather than an ask that can never answer.
    ["0", 180_000],
    ["-5", 180_000],
    ["abc", 180_000],
    ["", 180_000],
  ] as const) {
    await withEnv({ PI_ENSEMBLE_EXPLORE_REASK_BOUND_MS: value }, async () => {
      assert(
        exploreReaskBoundMs() === want,
        `(2) PI_ENSEMBLE_EXPLORE_REASK_BOUND_MS=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }

  // ── (3) the production child's ENV is the spawn path's env ─────────────────
  // Read off the child that ran, not off a builder: the defect this row exists
  // for was exactly "a builder that is not called".
  {
    installStubPi({
      lines: [agentEnd("INTENT-VERDICT: proceed\n\n## Spec\n\n### Intent\nx")],
      lingerMs: 0,
    });
    let out: Awaited<ReturnType<typeof spawnExploreReaskChild>> | undefined;
    await withEnv(
      {
        // A stale pair from an outer pi-rukas process: the strip must still own
        // it, the way the normal spawn path's does.
        PI_ENSEMBLE_FORGE_READ_SOCKET: "/tmp/outer/broker.sock",
        PI_ENSEMBLE_FORGE_READ_SECRET: "f".repeat(64),
        // The normal spawn's per-spawn root must not survive into this child
        // either — the re-ask's own dir is the only root it may delete into.
        [CHILD_TMP_ENV]: path.join(dir, "inherited-child-tmp"),
        GH_TOKEN: "operator-login-must-not-travel",
      },
      async () => {
        out = await spawnExploreReaskChild(ASK);
      },
    );
    assert(out !== undefined && out.ok === true, `(3) the child answered (${JSON.stringify(out)})`);
    const rec = readRecorded();
    // The premise gate: every claim below is an ABSENCE or a path assertion over
    // `rec.env`, and an empty dump satisfies some of them vacuously — so a stub
    // that never ran must never read as a pass. `GIT_EDITOR` is the non-interactive
    // pin the spawn path's builder writes, so it is evidence the child really ran.
    assert(
      rec.argv.length > 0 && rec.env.GIT_EDITOR === "true",
      `(3) the production path really launched a child and it recorded its own env (${String(rec.argv.length)} argv entries)`,
    );
    assert(
      rec.env[CHILD_ROLE_ENV] === "explore",
      `(3) the child carries PI_ENSEMBLE_ROLE=explore, so the role-scoped child guards judge it as the role it is (got ${JSON.stringify(rec.env[CHILD_ROLE_ENV])})`,
    );
    const childTmp = rec.env[CHILD_TMP_ENV];
    // The dir the stub printed is its OWN (its `finally` removed the tree once the
    // child exited, so the parent cannot stat it) — and it must not be the one
    // this case poisoned into `process.env`.
    assert(
      childTmp !== undefined &&
        childTmp !== path.join(dir, "inherited-child-tmp") &&
        childTmp.includes("pi-rukas-explore-reask-"),
      `(3) and its own per-child temp root, not an inherited one (got ${JSON.stringify(childTmp)})`,
    );
    for (const name of ["TMPDIR", "TMP", "TEMP"]) {
      assert(
        rec.env[name] === childTmp,
        `(3) ${name} is that same per-child dir so its tools scratch there (got ${JSON.stringify(rec.env[name])})`,
      );
    }
    const scratchHome = rec.env.HOME ?? "";
    // `basename` of the per-child dir the child itself printed: the ask removes
    // that tree the moment the child settles, so the snapshot directory is named
    // from the child's own report rather than from a path the parent can no longer
    // stat.
    const snapshotBase = rec.stdout.match(/SNAPSHOT=(\S+)/)?.[1] ?? path.basename(childTmp ?? "");
    assert(
      childTmp !== undefined &&
        scratchHome.startsWith(`${childTmp}${path.sep}`) &&
        scratchHome.endsWith(`${path.sep}home`) &&
        snapshotBase === path.basename(childTmp) &&
        existsSync(path.join(snapshots, "latest", "home")),
      `(3) a read-only role's HOME is a scratch under its per-child dir, and it existed while the child ran (got ${JSON.stringify(scratchHome)})`,
    );
    for (const name of ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
      assert(
        (rec.env[name] ?? "").startsWith(`${childTmp}${path.sep}`),
        `(3) ${name} is inside the scratch too (got ${JSON.stringify(rec.env[name])})`,
      );
    }
    assert(
      rec.env.GH_TOKEN === undefined,
      "(3) and the forge strip still ran: no operator token reached the child",
    );
    assert(
      rec.env.PI_ENSEMBLE_FORGE_READ_SOCKET === undefined &&
        rec.env.PI_ENSEMBLE_FORGE_READ_SECRET === undefined,
      "(3) and neither half of an inherited forge-read pair survived",
    );
    assert(
      rec.cwd !== "" && (rec.cwd === TREE || rec.cwd.replace(/\/$/, "") === TREE),
      `(3) the child started in the explore child's tree, not this process's cwd (child ${JSON.stringify(rec.cwd)})`,
    );
  }

  // ── (4) the role switch really reaches this child's env ────────────────────
  // (3) asserts the stamp is there; this asserts it is the ONE switch's doing,
  // so the child's env is gated the same way the spawn path's is.
  {
    installStubPi({
      lines: [agentEnd("INTENT-VERDICT: proceed\n\n## Spec\n\n### Intent\nx")],
      lingerMs: 0,
    });
    await withEnv({ PI_ENSEMBLE_CHILD_ROLE_ENV: "0" }, async () => {
      await spawnExploreReaskChild(ASK);
    });
    const rec = readRecorded();
    assert(
      rec.argv.length > 0 && rec.env.GIT_EDITOR === "true",
      `(4) the stub ran under the switch too (${String(rec.argv.length)} argv entries)`,
    );
    assert(
      rec.env[CHILD_ROLE_ENV] === undefined,
      `(4) PI_ENSEMBLE_CHILD_ROLE_ENV=0 leaves the role unstamped for this child too — the same escape hatch, honoured here (got ${JSON.stringify(rec.env[CHILD_ROLE_ENV])})`,
    );
    assert(
      rec.env[CHILD_TMP_ENV] !== undefined &&
        (rec.env.HOME ?? "").startsWith(`${rec.env[CHILD_TMP_ENV]}${path.sep}`),
      "(4) and the per-child temp root and its scratch HOME are still the spawn's own — the switch is the role stamp's, not the temp root's",
    );
  }

  // ── (5) a bound kill is not a discard: a reply that landed IS the answer ───
  {
    installStubPi({
      lines: [agentEnd("INTENT-VERDICT: proceed\n\n## Spec\n\n### Intent\nx")],
      lingerMs: 30_000,
    });
    const answered = await spawnExploreReaskChild({ ...ASK, boundMs: 400 });
    assert(
      answered.ok === true && answered.text.includes("INTENT-VERDICT"),
      `(5) a child the bound killed still answers with the reply it printed before the kill (${JSON.stringify(answered)})`,
    );

    installStubPi({ lines: [], lingerMs: 30_000 });
    const silent = await spawnExploreReaskChild({ ...ASK, boundMs: 400 });
    assert(
      silent.ok === false && silent.reason === "timeout",
      `(5) and a child that printed nothing is still a timeout, not an empty answer (${JSON.stringify(silent)})`,
    );

    installStubPi({
      lines: [agentEnd("INTENT-VERDICT: proceed\n\n## Spec\n\n### Intent\nx")],
      lingerMs: 0,
    });
    const missing = await spawnExploreReaskChild({
      ...ASK,
      transcriptPath: MISSING_SESSION,
    });
    assert(
      missing.ok === false && missing.reason === "no-session",
      `(5) a session that cannot be named spawns nothing and fails as no-session (${JSON.stringify(missing)})`,
    );
    assert(!existsSync(path.join(dir, "argv.txt")), "(5) and nothing was launched for it");
  }
} finally {
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_PI_BIN");
  _resetPiBinaryCache();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  `\nexplore re-ask child ${failures() === 0 ? "green" : "RED"} (${String(failures())} failing)`,
);
process.exit(failures());
