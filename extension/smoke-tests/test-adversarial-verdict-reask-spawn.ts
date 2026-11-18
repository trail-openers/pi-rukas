#!/usr/bin/env bun
/**
 * The adversarial verdict re-ask's PRODUCTION spawn: `spawnVerdictReaskChild`,
 * the function that assembles the child the pure seams in
 * `test-adversarial-verdict-reask-child.ts` only describe.
 *
 * Those pins assert an argv nobody launched. This file launches it: a stub `pi`
 * records the real invocation, the real env, and the real cwd the child ran in.
 * The shape is `test-session-reattach-resume.ts`'s real-path arm — there the
 * `spawnReattach` argument is OMITTED so the call routes into `reattachChild`;
 * here the `reask` seam is simply not supplied so the loop's ask routes into
 * `spawnVerdictReaskChild` (`adversarial-verdict-reask.ts` — its ONLY production
 * caller, and the only thing that has ever run this function).
 *
 * Three claims the pure seams cannot make, each the mutant it exists for:
 *
 *   1. **The whole assembly is keyed on the role being asked.** `args.role` is
 *      read for the credential strip, the model resolution, the operator-config
 *      guard, the system prompt, the prompt-file name AND the tool fence. A site
 *      that hardcoded one role's name keeps the child writable whenever another
 *      reviewer is re-asked — so the ask is driven for
 *      `code-review-specialist`, a valid reviewer role that is NOT the one this
 *      feature was written for, and its argv and env are read off the child that
 *      actually ran.
 *   2. **The child runs in the reviewed tree.** A `cwd` the loop never threads
 *      means the parent's process directory — a different checkout from the one
 *      the review read.
 *   3. **Nothing reaches the round from a child that never finished.** The stub
 *      prints the fenced report a resumed session replays, then the answer, then
 *      hangs until the bound kills it: the only answer that can be read is the
 *      last turn's, and a stream cut short answers nothing.
 *
 * What happens when the child CANNOT be assembled or cannot be started at all —
 * a prompt file that cannot be read, a temp root that refuses `mkdtemp`, a seam
 * that rejects — is `test-adversarial-verdict-reask-spawn-failure.ts`'s subject
 * (AGENTS.md §12 split). Both files run on one stage from
 * `lib/adversarial-reask-spawn-fixtures.ts`.
 */

import { existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnVerdictReaskChild } from "../src/adversarial-verdict-reask-child.ts";
import { reaskRoundVerdict } from "../src/adversarial-verdict-reask.ts";
import type { DispatchResult } from "../src/types.ts";
import { NOOP_TALLY, createReaskSpawnStage } from "./lib/adversarial-reask-spawn-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const {
  dir,
  SESSION,
  REVIEW_TREE,
  installStubPi,
  readRecorded,
  clearRecorded,
  reviewerRound,
  dispose,
} = createReaskSpawnStage("reask-spawn");
const tally = NOOP_TALLY;

/** A reviewer result that reported no model at all — the key is ABSENT, which is
 * what makes the child's `--model` evidence of the role `resolveModel` was asked
 * about (a present-but-`undefined` key would be forwarded by the ask's own
 * conditional spread and read as an explicit override). */
function withoutModel(role: string): DispatchResult {
  const { model: _reported, ...rest } = reviewerRound();
  return { ...rest, role };
}

try {
  // ── (13) the production child: role-derived strip, reviewed tree, no login ─
  // A role OTHER than `adversarial-developer` is the point: the env strip must
  // follow `args.role`, so a hardcoded literal shows up as a child that kept a
  // credential the asked-for role should not have held.
  const TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN"];
  installStubPi({ hang: false, answer: "VERDICT: ISSUES_FOUND" });
  // The asked role's OWN model, distinct from every other role's and from the
  // global fallback: the child's `--model` is then evidence of which role
  // `resolveModel` was asked about.
  const ROLE_MODEL_ENV = "PI_ENSEMBLE_MODEL_CODE_REVIEW_SPECIALIST";
  const GLOBAL_MODEL_ENV = "PI_ENSEMBLE_SUBAGENT_MODEL";
  // The operator's own saved model choices are out of the way: they sit ABOVE
  // the per-role env in the resolution order, so this suite's env pins would be
  // shadowed by a machine's `ensemble-models.json`. An empty config file makes
  // the role env the highest live tier — which is what makes `--model` evidence
  // of the role `resolveModel` was asked about.
  const modelsConfig = path.join(dir, "models.json");
  writeFileSync(modelsConfig, '{"models":{}}\n');
  let recovered: Awaited<ReturnType<typeof reaskRoundVerdict>>;
  await withEnv(
    {
      PI_ENSEMBLE_MODELS_CONFIG: modelsConfig,
      ...Object.fromEntries(TOKENS.map((t) => [t, "operator-login-must-not-travel"])),
      GH_CONFIG_DIR: path.join(dir, "operator-config"),
      [ROLE_MODEL_ENV]: "role-owned-model",
      [GLOBAL_MODEL_ENV]: "the-global-fallback",
    },
    async () => {
      recovered = await reaskRoundVerdict(
        // The role, not the reviewer's result, decides: `adv.role` is what the
        // ask reads, and the reviewer reported no model, so the child's
        // `--model` can only come from resolving the role IT was asked about.
        withoutModel("code-review-specialist"),
        1,
        tally,
        undefined, // no seam: this routes into spawnVerdictReaskChild
        "job-reask-spawn",
        REVIEW_TREE,
      );
    },
  );

  const rec = readRecorded();
  assert(
    rec.argv.length > 0,
    `(13) the production path really launched a child (${String(rec.argv.length)} argv entries)`,
  );
  const at = (flag: string): string | undefined => rec.argv[rec.argv.indexOf(flag) + 1];
  assert(
    at("--session") === SESSION,
    `(13) it resumed the reviewer's OWN session file (${String(at("--session"))})`,
  );
  assert(
    at("--model") === "role-owned-model",
    `(13) its model is the ASKED ROLE's own, so the model resolution took args.role and not a literal (${String(at("--model"))})`,
  );
  assert(
    rec.argv.includes("--no-extensions") && rec.argv.some((a) => a.includes("child-guards")),
    "(13) no extensions, and the mode-independent child guards are loaded",
  );
  assert(
    (at("--exclude-tools") ?? "")
      .split(",")
      .every((t) => ["write", "edit", "multiedit"].includes(t)) &&
      ["write", "edit", "multiedit"].every((t) => (at("--exclude-tools") ?? "").includes(t)),
    `(13) the child cannot write: --exclude-tools ${String(at("--exclude-tools"))}`,
  );
  assert(
    !rec.argv.some((a) => a.includes("codemode")),
    "(13) and it carries no codemode — one line needs no scripting",
  );
  // The role the child was ASKED for reaches every part of its assembly. Two
  // independent readings of the child's own record, because the two ways to lose
  // it fail differently: a literal role name that overrides `args.role` still
  // strips (every reviewer strips alike) but resolves the WRONG role's model, and
  // one lost `args.role` in `reaskChildArgs` leaves the child WRITABLE, since
  // `excludeToolsFor("")` omits the flag entirely.
  const leaked = TOKENS.filter((t) => rec.env[t] === "operator-login-must-not-travel");
  assert(
    leaked.length === 0,
    `(13) the strip is derived from args.role — a code-review-specialist child kept none of the operator's forge login (leaked: ${leaked.join(", ") || "none"})`,
  );
  assert(
    rec.argv.includes("--exclude-tools") &&
      rec.argv.some(
        (a, i) =>
          rec.argv[i - 1] === "--append-system-prompt" && a.endsWith("/code-review-specialist.md"),
      ),
    `(13) every part of the assembly followed the asked role: its OWN tool fence is present (--exclude-tools ${String(at("--exclude-tools"))}) and its prompt file is named for the role asked (${String(at("--append-system-prompt"))})`,
  );
  // Both config roots are redirected to ONE fresh private dir that is NOT the
  // inherited one, and it really is empty — an inherited operator root surviving
  // the token strip is the fallback the strip exists to close.
  const childConfig = rec.env.GH_CONFIG_DIR ?? "";
  assert(
    childConfig !== "" &&
      childConfig !== path.join(dir, "operator-config") &&
      rec.env.GLAB_CONFIG_DIR === childConfig &&
      existsSync(childConfig) &&
      readdirSync(childConfig).length === 0,
    `(13) both forge config roots point at one fresh EMPTY dir, not the inherited one (${childConfig || "<unset>"})`,
  );
  assert(
    rec.env.PI_ENSEMBLE_ROLE === undefined,
    "(13) and no PI_ENSEMBLE_ROLE was stamped for a role the spawner invented",
  );
  // The tree the child started in is the reviewed one, not this process's cwd.
  const sameTree = (a: string, b: string): boolean => {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return a === b;
    }
  };
  assert(
    rec.cwd !== "" && sameTree(rec.cwd, REVIEW_TREE),
    `(13) the child ran in the REVIEWED tree, not the parent's cwd (child ${JSON.stringify(rec.cwd)}, parent ${JSON.stringify(process.cwd())})`,
  );
  assert(
    recovered !== undefined && recovered.verdict.status === "ISSUES_FOUND",
    `(13) and the answer the child printed is the verdict the round got (${JSON.stringify(recovered?.verdict.status)})`,
  );
  assert(
    recovered !== undefined && recovered.verdict.findings === reviewerRound().text,
    "(13) the round still carries the ORIGINAL reviewer's findings, not the re-ask's one line",
  );

  // ── (14) a child the bound kills answers nothing ────────────────────────────
  // The stub replays the fenced report AND prints a readable answer, then lingers.
  // If a killed child's partial stream could sign, this is where it would. The
  // bound is supplied directly rather than through the loop's constant, so the
  // case measures its own seconds instead of the feature's five minutes.
  installStubPi({ hang: true, answer: "VERDICT: APPROVED" });
  const killed = await spawnVerdictReaskChild({
    transcriptPath: SESSION,
    role: "adversarial-developer",
    model: "reviewer-model-1",
    cwd: REVIEW_TREE,
    boundMs: 300,
    prompt: "reply with the verdict line",
  });
  assert(
    killed.ok === false && killed.reason === "timeout",
    `(14) a child killed by its own bound answers nothing even though its stream carried a verdict (${JSON.stringify(killed)})`,
  );

  // ── (15) no session file, no child ──────────────────────────────────────────
  clearRecorded();
  const missing = await reaskRoundVerdict(
    { ...reviewerRound(), transcriptPath: path.join(dir, "never-written.json") },
    1,
    tally,
    undefined,
    "job-reask-missing",
    REVIEW_TREE,
  );
  assert(
    missing === undefined && !existsSync(path.join(dir, "argv.txt")),
    "(15) a missing session file refuses before any child starts — nothing was launched",
  );
} finally {
  dispose();
}

console.log(
  `\nre-ask production spawn ${failures() === 0 ? "green" : "RED"} (${String(failures())} failing)`,
);
process.exit(failures());
