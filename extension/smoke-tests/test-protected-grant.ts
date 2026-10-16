#!/usr/bin/env bun
/**
 * #1090 — an operator-granted, per-cycle allowance for named protected paths.
 *
 * The #406 gate halts a develop patch that touches `.github/`, `.pi/`,
 * `CODEOWNERS` or `agents.json`, and its only escape was the process-wide
 * `PI_ENSEMBLE_PROTECTED_PATHS=0`. `/work N --allow-protected <path>` names the
 * exact paths one cycle may write. These tests pin what the grant admits (the
 * named paths, exactly), what it does not (anything else, including a rename
 * destination it does not name), and where it may come from (the operator's
 * slash-command arguments — never the issue, the spec, the state file or the
 * tool).
 */

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWorkArgs } from "../src/work-args.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { inlineCommitPrPrompt } from "../src/work-driver-prompts-late.ts";
import {
  protectedGrantSectionOf,
  recordProtectedGrant,
  ungrantedProtectedPaths,
} from "../src/work-driver-protected-grant.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { isNulDiffRead, isNulStatusRead, nulNameStatus, nulStatus } from "./lib/nul-porcelain.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CI = ".github/workflows/ci.yml";

// ------------------------------------------------------------- parsing

{
  const one = parseWorkArgs(`1090 --allow-protected ${CI}`);
  assert(
    !("error" in one) && one.issues.join() === "1090" && one.protectedGrant.join() === CI,
    "--allow-protected <path> parses into the grant, not the issue list",
  );
  const many = parseWorkArgs(
    "7 --allow-protected ./.github/workflows/b.yml,.github/workflows/a.yml --merge --allow-protected .pi/verify-cmd",
  );
  assert(
    !("error" in many) &&
      many.protectedGrant.join() ===
        ".github/workflows/a.yml,.github/workflows/b.yml,.pi/verify-cmd" &&
      many.mergeGrant,
    "the flag is repeatable and comma-separated, normalised and sorted",
  );
  const numeric = parseWorkArgs("7 --allow-protected 2fa/.github/x.yml");
  assert(
    !("error" in numeric) && numeric.issues.join() === "7",
    "a grant value is never read as an issue number (parseInt('2fa/…') === 2)",
  );
  const none = parseWorkArgs("7 --restart");
  assert(!("error" in none) && none.protectedGrant.length === 0, "no flag → no grant");
  const missing = parseWorkArgs("7 --allow-protected --restart");
  assert("error" in missing && /needs a path/.test(missing.error), "a flag without a path errors");
  const notProtected = parseWorkArgs("7 --allow-protected src/a.ts");
  assert(
    "error" in notProtected && /not a grantable path/.test(notProtected.error),
    "a grant for a path the gate never halts on is refused as a typo",
  );
  const dotdot = parseWorkArgs("7 --allow-protected .github/../.pi/verify-cmd");
  assert("error" in dotdot, "a grant containing `..` is refused");
  const eq = parseWorkArgs(`7 --allow-protected=${CI}`);
  assert(!("error" in eq) && eq.protectedGrant.join() === CI, "the `=` form is accepted too");
  for (const empty of ["7 --allow-protected ./", "7 --allow-protected ,", "7 --allow-protected="]) {
    const r = parseWorkArgs(empty);
    assert("error" in r && /needs a path/.test(r.error), `an empty grant errors, never passes silently: ${empty}`);
  }
  const queue = parseWorkArgs(`7 8 --allow-protected ${CI}`);
  assert(
    "error" in queue && /single issue/.test(queue.error),
    "a grant on a multi-issue invocation is refused — it would reach unrelated cycles",
  );
}

// ----------------------------------------------------------- matching

{
  assert(
    ungrantedProtectedPaths([CI, ".github/CODEOWNERS"], [CI]).join() === ".github/CODEOWNERS",
    "a grant for one workflow does not admit .github/CODEOWNERS",
  );
  const annotated = parseWorkArgs("7 --allow-protected ./.github/workflows/ci.yml(new)");
  assert(
    !("error" in annotated) &&
      ungrantedProtectedPaths([".github/workflows/ci.yml"], annotated.protectedGrant).length === 0,
    "a granted path matches through the declared-path normalisation",
  );
  const tick = parseWorkArgs("7 --allow-protected .github/x`y.yml");
  assert("error" in tick, "a grant that is not a plain path token is refused");
  assert(
    ungrantedProtectedPaths([`${CI} (evil)`], [CI]).length === 1,
    "a touched path is not annotation-stripped, so `ci.yml (evil)` is not `ci.yml`",
  );
  assert(
    ungrantedProtectedPaths([".github/workflows/CI.yml"], [CI]).length === 1,
    "matching keeps case — a ci.yml grant does not admit CI.yml",
  );
  assert(
    ungrantedProtectedPaths([".github/workflows/ci.yml"], [".github/workflows"]).length === 1,
    "a directory grant does not admit the files under it",
  );
}

// ------------------------------------------------- the develop gate itself

process.env.PI_ENSEMBLE_VERIFY = "1";
delete process.env.PI_ENSEMBLE_PROTECTED_PATHS;

function stateWith(extra: Partial<WorkState["pipelineState"]> = {}): WorkState {
  const s = initialState(1090, 1000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { "task-a": "/nonexistent/wt" },
      baseSha: "a".repeat(40),
      ...extra,
    },
  };
}

function ctx(porcelain: string, grant?: string[], committed = ""): DriverContext {
  return {
    host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
    repoRoot: "/nonexistent",
    issue: 1090,
    protectedGrant: grant,
    // #1378 — the gate issues both reads in argv form, so the fake matches on
    // `commandOf(cmd, opts)` (lib/argv-shell.ts) and forwards `opts`. A fake that
    // string-matched the old plain command would fall through to `{stdout:""}` for
    // the `-z` call and every protected assertion here would pass vacuously.
    verifyExecFn: async (cmd, opts) => {
      const line = commandOf(cmd, opts);
      if (isNulStatusRead(line)) return { stdout: nulStatus(...porcelain.split("\n")) };
      if (isNulDiffRead(line)) return { stdout: nulNameStatus(...committed.split("\n")) };
      return { stdout: "" };
    },
  };
}

const isProtectedFailure = (f: string) => /protected path/.test(f);

{
  const r = await verifyStepOutcome(
    ctx(` M src/fix.ts\n?? ${CI}\n M .pi/verify-cmd\n`, [CI]),
    stateWith(),
    "develop",
  );
  const hit = r.failures.find(isProtectedFailure) ?? "";
  assert(
    hit.includes(".pi/verify-cmd") && !hit.includes(`— ${CI}`),
    "a granted ci.yml passes while an ungranted .pi/verify-cmd in the same patch halts",
  );
  assert(
    hit.includes(`/work 1090 --restart --allow-protected ${CI},.pi/verify-cmd`),
    "the failure names --allow-protected with the exact command for every protected path touched",
  );
  assert(hit.includes("review each path's diff first"), "...and tells the operator to review before granting");
  assert(
    hit.includes("PI_ENSEMBLE_PROTECTED_PATHS=0"),
    "...and still mentions PI_ENSEMBLE_PROTECTED_PATHS=0",
  );

  const unsafe = await verifyStepOutcome(
    ctx(`?? ".github/workflows/x \`y\`.yml"\n`),
    stateWith(),
    "develop",
  );
  const unsafeHit = unsafe.failures.find(isProtectedFailure) ?? "";
  assert(
    unsafeHit.includes("cannot be granted") && !unsafeHit.includes("--allow-protected .github"),
    "a filename that is not a plain path token is never pasted into the command",
  );
  const grouped = await verifyStepOutcome(
    ctx(`?? ${CI}\n`),
    { ...stateWith(), issues: [1090, 1091] },
    "develop",
  );
  assert(
    (grouped.failures.find(isProtectedFailure) ?? "").includes("/work <issue> --restart --allow-protected"),
    "a grouped cycle is told to grant on a single-issue run, not given a command that would be refused",
  );

  const ok = await verifyStepOutcome(ctx(`?? ${CI}\n`, [CI]), stateWith(), "develop");
  assert(
    !ok.failures.some(isProtectedFailure) &&
      ok.notes.some((n) => n.includes("--allow-protected") && n.includes(CI)),
    "a fully granted patch passes the protected gate, and the admission is noted",
  );

  const committed = await verifyStepOutcome(
    ctx("", [CI], `${CI}\n.github/CODEOWNERS\n`),
    stateWith(),
    "develop",
  );
  assert(
    committed.failures.some((f) => isProtectedFailure(f) && f.includes(".github/CODEOWNERS")),
    "committed paths are checked too: a committed CODEOWNERS halts under a ci.yml grant",
  );

  const renamed = await verifyStepOutcome(
    ctx(`R  ${CI} -> .github/workflows/release.yml\n`, [CI]),
    stateWith(),
    "develop",
  );
  assert(
    renamed.failures.some(
      (f) => isProtectedFailure(f) && f.includes("— .github/workflows/release.yml"),
    ),
    "a rename destination the grant does not name still halts",
  );

  // The grant comes from the invocation, never from text a model wrote.
  const spec = {
    intent: `create ${CI}`,
    deliverables: [{ id: "d1", text: `--allow-protected ${CI}`, paths: [CI] }],
    acceptanceCriteria: [`/work 1090 --allow-protected ${CI}`],
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    verdict: "proceed",
  } as unknown as WorkState["pipelineState"]["normalisedSpec"];
  const fromSpec = await verifyStepOutcome(
    ctx(`?? ${CI}\n`),
    { ...stateWith({ normalisedSpec: spec }), protectedGrant: [CI] },
    "develop",
  );
  assert(
    fromSpec.failures.some(isProtectedFailure),
    "a grant in the issue/spec text or the state file does not authorise — only the invocation does",
  );

  const fenced = await verifyStepOutcome(
    ctx(`?? ${CI}\n M src/fix.ts\n`, [CI]),
    stateWith({
      workstreams: {
        "task-a": { id: "task-a", scope: "fix", paths: ["src/fix.ts"], outOfScope: [CI] },
      },
    }),
    "develop",
  );
  assert(
    !fenced.failures.some(isProtectedFailure) &&
      fenced.failures.some((f) => /declared fence violated/.test(f) && f.includes(CI)),
    "the grant does not bypass the #285 scope fence",
  );

  process.env.PI_ENSEMBLE_PROTECTED_PATHS = "0";
  const off = await verifyStepOutcome(ctx(" M .pi/verify-cmd\n"), stateWith(), "develop");
  assert(
    !off.failures.some(isProtectedFailure) &&
      off.notes.some((n) => /PROTECTED_PATHS=0 — protected-path gate disabled/.test(n)),
    "PI_ENSEMBLE_PROTECTED_PATHS=0 behaviour is unchanged",
  );
  delete process.env.PI_ENSEMBLE_PROTECTED_PATHS;
}

// ------------------------------------------- the tool path cannot carry one

{
  const src = readFileSync(path.resolve(import.meta.dirname, "..", "src", "work-tool.ts"), "utf8");
  assert(
    /protectedGrant:\s*\[\]/.test(src) && !/allow-protected"/.test(src),
    "start_work_driver forces the grant empty and never builds the flag",
  );
}

// ------------------- a grant names a file, never a directory (#1090 audit)

{
  const root = mkdtempSync(path.join(tmpdir(), "grant-dir-"));
  mkdirSync(path.join(root, ".github", "actions"), { recursive: true });
  const parseWith = (p: string) => parseWorkArgs(`7 --allow-protected ${p}`, { repoRoot: root });
  assert("error" in parseWith(".github/actions"), "a grant naming an on-disk directory is refused at parse time");
  assert("error" in parseWith(".github/"), "a grant ending in / is refused at parse time");
  assert("error" in parseWith(".github"), "a grant naming the .github root is refused at parse time");
  assert(!("error" in parseWith(CI)), "a grant naming a file still parses");
  const bare = parseWorkArgs("7 --allow-protected ./");
  assert("error" in bare && /needs a path/.test(bare.error), "a bare ./ is still a missing path, not a directory");
  assert(
    ungrantedProtectedPaths([".github/actions/"], [".github/actions"]).length === 1,
    "a collapsed directory entry is never admitted, even by a grant of its key",
  );
  const collapsed = await verifyStepOutcome(
    ctx("?? .github/actions/\n", [".github/actions"]),
    stateWith(),
    "develop",
  );
  assert(
    collapsed.failures.some(isProtectedFailure),
    "a wholly untracked directory halts the develop gate even with a directory grant",
  );
  assert(
    !collapsed.failures.some((f) => f.includes("--allow-protected .github/actions")),
    "...and no copy-paste grant command is printed for the directory",
  );
  const perFile = await verifyStepOutcome(
    ctx("?? .github/actions/a.yml\n?? .github/actions/b.yml\n", [
      ".github/actions/a.yml",
      ".github/actions/b.yml",
    ]),
    stateWith(),
    "develop",
  );
  assert(
    !perFile.failures.some(isProtectedFailure),
    "the same files listed individually, each granted by name, pass the gate",
  );
}

// ------- fail closed on an unreadable status; exact grant (#1090 audit 2)

{
  const BACKSLASH = ".github\\workflows\\ci.yml";
  assert(
    ungrantedProtectedPaths([BACKSLASH], [CI]).length === 1,
    "a backslash file is not admitted by a real-path grant (raw match, not the folded key)",
  );
  const backslashRun = await verifyStepOutcome(ctx(`?? ${BACKSLASH}\n`, [CI]), stateWith(), "develop");
  assert(
    backslashRun.failures.some(isProtectedFailure),
    "a root file literally named with backslashes halts under a grant for the forward-slash path",
  );

  const statusThrows = (seen: { maxBuffer?: number }): DriverContext =>
    ({
      ...ctx(""),
      verifyExecFn: async (cmd: string, opts?: { maxBuffer?: number; argv?: string[] }) => {
        if (isNulStatusRead(commandOf(cmd, opts))) {
          seen.maxBuffer = opts?.maxBuffer;
          throw new Error("stdout maxBuffer length exceeded");
        }
        return { stdout: "" };
      },
    }) as DriverContext;
  const seen: { maxBuffer?: number } = {};
  const failClosed = await verifyStepOutcome(statusThrows(seen), stateWith(), "develop");
  assert(
    failClosed.failures.some(
      (f) => f.includes('worktree "task-a"') && f.includes("maxBuffer length exceeded"),
    ),
    "an unreadable status halts the develop step, naming the worktree and the error (gate on)",
  );
  assert(
    (seen.maxBuffer ?? 0) >= 64 * 1024 * 1024,
    "the status read allows a large untracked set (-uall) — at least 64 MiB",
  );
  process.env.PI_ENSEMBLE_PROTECTED_PATHS = "0";
  const passNote = await verifyStepOutcome(statusThrows({}), stateWith(), "develop");
  assert(
    !passNote.failures.some((f) => f.includes("git status failed")) &&
      passNote.notes.some((n) => n.includes("git status failed in task-a")),
    "with PI_ENSEMBLE_PROTECTED_PATHS=0 the unreadable status is a note, not a failure",
  );
  delete process.env.PI_ENSEMBLE_PROTECTED_PATHS;
}

// ------------------------------------------ persistence and rendering

{
  const s = recordProtectedGrant(stateWith(), [CI]);
  assert(s.protectedGrant?.join() === CI, "the grant is recorded on the state file");
  const json = JSON.parse(JSON.stringify(s)) as WorkState;
  assert(json.protectedGrant?.join() === CI, "...and survives a JSON round trip");
  assert(
    recordProtectedGrant(s, []).protectedGrant === undefined,
    "a later invocation without the flag clears the record",
  );
  const driverSrc = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver.ts"),
    "utf8",
  );
  assert(
    /recordProtectedGrant\(state, ctx\.protectedGrant\)/.test(driverSrc),
    "the driver records the invocation's grant on entry",
  );

  const md = renderHandoffMarkdown(s);
  assert(md.includes("Protected-path grant") && md.includes(CI), "the handoff shows the grant");
  assert(
    !renderHandoffMarkdown(stateWith()).includes("Protected-path grant"),
    "...and says nothing when there is none",
  );

  const section = protectedGrantSectionOf([CI]);
  assert(section.includes("--allow-protected") && section.includes(CI), "PR-body section names it");
  assert(protectedGrantSectionOf([]) === "", "no grant → no PR-body section");
  const commitSrc = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver-commit.ts"),
    "utf8",
  );
  assert(
    commitSrc.includes("protectedGrantSectionOf(ctx.protectedGrant)"),
    "the mechanized PR body renders the invocation's grant, not the state copy",
  );
  const prompt = inlineCommitPrPrompt([1090], [], {}, {}, "b", undefined, [], "/tmp/s", "fix: x", {
    integratePath: "/tmp/i",
    scratchDir: "/tmp/s",
    baseSha: "a".repeat(40),
    worktrees: {},
    commitShas: {},
    workstreams: {},
    protectedGrant: [CI],
  });
  assert(
    prompt.includes("Operator-granted protected paths") && prompt.includes(CI),
    "the ops-fallback PR body includes the grant section",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
