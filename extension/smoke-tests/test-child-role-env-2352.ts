/**
 * test-child-role-env-2352 — the role stamp that makes a role-scoped child guard
 * reachable, and the reviewer confinement that was inert without it (#2352).
 *
 * The defect in one line: `PI_ENSEMBLE_ROLE` was assigned to the dispatch PLAN
 * (`spawn-plan.ts`) and never to the child's ENVIRONMENT, and every role-scoped
 * guard reads it from `process.env` — `write-fence-deps.ts` through
 * `isReadOnlyRole`, `developer-push-guard.ts` by literal comparison. So a reviewer
 * child's bash ran with no role to read, and the rule that was supposed to judge
 * it never fired. The two groups below are the pair: the stamp exists and reaches
 * the child, and the guard that consumes it is installed where it can fire.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CHILD_ROLE_ENV,
  ROLE_SWITCH,
  childRoleEnvEnabled,
  childRoleEnvValue,
} from "../src/child-role-env.ts";
import {
  isConfinedRole,
  reviewerScratchHomeEnabled,
  reviewerWriteGuardEnabled,
} from "../src/reviewer-scratch-home.ts";
import { WRITE_FENCE_ENV } from "../src/write-fence-contract.ts";
import { CHILD_TMP_ENV } from "../src/write-fence-deletion.ts";
import {
  REVIEWER_OUTSIDE_REASON,
  firstReviewerWriteOutside,
  registerReviewerWriteGuard,
  reviewerRefusalText,
  reviewerRootsFrom,
} from "../src/write-fence-reviewer.ts";

const SRC = path.resolve(import.meta.dirname, "..", "src");
const read = (f: string) => Bun.file(path.join(SRC, f)).text();

const REPO = path.resolve(import.meta.dirname, "..", "..");
const child = (env: Record<string, string>) =>
  spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], {
    env,
    encoding: "utf8",
  });

async function run() {
  await structuralCanaries();
  await stampReachesTheChild();
  await guardJudgeTable();
  await registrationGates();
  console.log("\nchild-role-env / reviewer write guard (#2352): all groups passed");
}

// ============================================================
// A. The switches and the canaries the issue asks for.
// ============================================================
async function structuralCanaries() {
  console.log("── A. switches + canaries ──");

  assert.equal(ROLE_SWITCH, "PI_ENSEMBLE_CHILD_ROLE_ENV");
  const inputs = await read("headless/inputs.ts");
  // "The switch is registered as a headless input and in the capability list."
  // Asserted against the exported list rather than a source literal: the entries
  // name their suffix (`flag("CHILD_ROLE_ENV", …)`), and `--capabilities` prints
  // this same array (capabilities.ts), so the list IS the capability list.
  const { HEADLESS_INPUTS } = await import("../src/headless/inputs.ts");
  const names = new Set(HEADLESS_INPUTS.map((i) => i.name));
  for (const name of [
    "PI_ENSEMBLE_CHILD_ROLE_ENV",
    "PI_ENSEMBLE_REVIEWER_SCRATCH_HOME",
    "PI_ENSEMBLE_REVIEWER_WRITE_GUARD",
  ]) {
    assert.ok(names.has(name), `${name} is a declared headless input (capability list)`);
  }
  assert.ok(
    /flag\("CHILD_ROLE_ENV", true\)/.test(inputs),
    'the stamp defaults ON, and only "0" disables it',
  );

  // "The env construction site is asserted to include the variable (source canary)"
  // — the value is injected, so the call site is what proves it is not forgotten.
  const spawnEnv = await read("spawn-child-env.ts");
  assert.ok(
    /childRoleEnv\(|childEnv\[CHILD_ROLE_ENV\] = /.test(spawnEnv) &&
      /reviewerScratchHomeEnv\(/.test(spawnEnv),
    "buildChildEnv injects both the role stamp and the scratch HOME",
  );
  assert.ok(
    /buildChildEnv\(\s*role: string,/.test(spawnEnv),
    "buildChildEnv takes the plan's role, not a re-derived one",
  );

  // "The hook is registered in the companion ABOVE the SUBAGENT_MODE early-return,
  // next to registerWriteFence/registerDeletionGuard" — asserted by the hook count
  // in test-child-guards-loaded-hooks.ts; the placement is pinned here.
  const guards = await read("child-guards.ts");
  const hookPos = guards.indexOf("registerReviewerWriteGuard(failClosedPi(pi))");
  const fencePos = guards.indexOf("registerWriteFence(failClosedPi(pi))");
  const noopPos = guards.indexOf('env.PI_ENSEMBLE_SUBAGENT_MODE === "1"');
  assert.ok(hookPos > 0 && fencePos > 0, "the guard is registered beside the fence");
  assert.ok(
    hookPos < noopPos && fencePos < noopPos,
    "both sit above the PI_ENSEMBLE_SUBAGENT_MODE early-return, so a strict/headless child is judged too",
  );
  assert.ok(
    guards.includes("registerReviewerWriteGuard(failClosedPi(pi))"),
    "the guard registers through failClosedPi, so an internal fault is a refusal, not a pass",
  );

  // R11: the role is not one of the fence's roots, and it must NOT join that list:
  // `childEnvFor` filters every name in it out of a nested dispatch's env, and a
  // nested child still has to know its own role. The stamp is asserted at the one
  // production construction site instead (group B).

  assert.equal(CHILD_ROLE_ENV, "PI_ENSEMBLE_ROLE");
  assert.equal(childRoleEnvEnabled({}), true, "on by default");
  assert.equal(childRoleEnvEnabled({ [ROLE_SWITCH]: "0" }), false, 'only "0" disables');
  assert.equal(childRoleEnvEnabled({ [ROLE_SWITCH]: "1" }), true);
  assert.equal(reviewerScratchHomeEnabled({}), true);
  assert.equal(reviewerWriteGuardEnabled({}), true);
  assert.equal(isConfinedRole("adversarial-developer"), true);
  assert.equal(isConfinedRole("code-review-specialist"), true);
  assert.equal(isConfinedRole("explore"), true);
  assert.equal(isConfinedRole("developer"), false, "a developer is the driver's fence to enforce");
  assert.equal(isConfinedRole(undefined), false, "an unroled child is not confined by name");

  // R9: the value is the plan's string, verbatim and in the plan's OWN alphabet —
  // "lens-fix" is not in READ_ONLY_ROLES' spelling and must not be renamed.
  assert.equal(childRoleEnvValue("lens-fix"), "lens-fix");
  assert.equal(childRoleEnvValue("adversarial-developer"), "adversarial-developer");
  assert.equal(childRoleEnvValue(undefined), undefined, "no role, no stamp (never an empty one)");
  assert.equal(childRoleEnvValue(""), undefined);
  assert.equal(childRoleEnvValue("  explore  "), "explore", "trimmed, not rewritten");
  console.log("✓ A passed");
}

// ============================================================
// B. The stamp is a real child environment variable, set by the real
// construction site — not a value the test injects itself. The env is built by
// importing `buildChildEnv` (the production function spawn.ts calls once) and
// handing it a plan of the shape `planChildPermissions` produces.
// ============================================================
async function stampReachesTheChild() {
  console.log("── B. the stamp reaches the child ──");
  const base = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    PI_ENSEMBLE_CHILD_TMP: mkdtempSync(path.join(tmpdir(), "role-env-")),
  };
  const plan = {
    forge: { socketPath: undefined, configDir: undefined, secret: undefined },
    ready: Promise.resolve(),
  } as never;
  const { buildChildEnv } = await import("../src/spawn-child-env.ts");
  const built = (role: string | undefined, env: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const out = buildChildEnv(role ?? "", plan, undefined, base.PI_ENSEMBLE_CHILD_TMP);
    for (const k of Object.keys(env)) delete process.env[k];
    return out as Record<string, string>;
  };

  const on = built("code-review-specialist");
  assert.equal(on[CHILD_ROLE_ENV], "code-review-specialist", "buildChildEnv stamps the role");
  assert.ok(
    on.HOME !== undefined && on.HOME !== base.HOME && on.HOME.includes("home"),
    `and it relocates HOME into the child's scratch (${on.HOME})`,
  );
  assert.equal(on.XDG_STATE_HOME, path.join(on.HOME, ".local", "state"));
  assert.equal(
    on.VIPUNE_DATABASE_PATH,
    process.env.VIPUNE_DATABASE_PATH ?? path.join(process.env.HOME ?? "", ".vipune", "memories.db"),
    "R12: vipune's real variable is re-exported, not silently moved",
  );
  assert.notEqual(on.VIPUNE_DATABASE_PATH, undefined);
  // R10: the scratch HOME is a directory on disk before the child runs.
  assert.ok(existsSync(on.HOME), "the scratch HOME exists — a tool finding none writes nothing");
  assert.ok(existsSync(on.XDG_CACHE_HOME), "and so do the XDG roots");
  assert.equal(
    readdirSync(path.dirname(base.PI_ENSEMBLE_CHILD_TMP)).includes("home"),
    false,
    "the scratch lives under the per-spawn dir, not beside it",
  );

  const env = await child({ ...base, ...on });
  assert.equal(env.status, 0, "the child ran");
  const seen = JSON.parse(env.stdout) as Record<string, string | undefined>;
  assert.equal(
    seen[CHILD_ROLE_ENV],
    "code-review-specialist",
    "the stamp is in the CHILD's process.env, where the guards read it",
  );

  // Off is off, and the two switches are independent of each other.
  const off = built("code-review-specialist", {
    [ROLE_SWITCH]: "0",
    PI_ENSEMBLE_REVIEWER_SCRATCH_HOME: "0",
    PI_ENSEMBLE_REVIEWER_WRITE_GUARD: "0",
  });
  assert.equal(off[CHILD_ROLE_ENV], undefined, "PI_ENSEMBLE_CHILD_ROLE_ENV=0 → no stamp at all");
  assert.notEqual(
    off.HOME,
    on.HOME,
    "the scratch-home switch is independent of the stamp: with it off, HOME is no longer the scratch",
  );
  const offChild = await child({ ...base, ...off });
  assert.equal(
    CHILD_ROLE_ENV in (JSON.parse(offChild.stdout) as Record<string, unknown>),
    false,
    "the off child has no role to read (so every role-scoped guard is inert again — R11's honest off arm)",
  );

  // Only the HOME half is off, the stamp stays: the switches are orthogonal.
  const halfOff = built("code-review-specialist", {
    PI_ENSEMBLE_REVIEWER_WRITE_GUARD: "0",
  });
  assert.equal(halfOff[CHILD_ROLE_ENV], "code-review-specialist");
  assert.notEqual(
    halfOff.HOME,
    on.HOME,
    "the redirect is gated on the GUARD too — an unguarded redirect is isolation nobody can rely on",
  );

  // R9: a lens-fix child carries the plan's spelling, not READ_ONLY_ROLES' name.
  const lens = await child({ ...base, ...built("lens-fix") });
  assert.equal(
    JSON.parse(lens.stdout)[CHILD_ROLE_ENV],
    "lens-fix",
    "the stamp is the plan's string verbatim (R9)",
  );

  // A child with no role gets no stamp, and never an empty one.
  const unroled = await child({ ...base, ...built(undefined) });
  assert.equal(
    CHILD_ROLE_ENV in (JSON.parse(unroled.stdout) as Record<string, unknown>),
    false,
    "no role → the key is absent, not empty",
  );

  // No recovery, and none was ever reachable: the companion used to read the role
  // back out of `PI_ENSEMBLE_CHILD_ID`, a name the spawn never set, so the hook could
  // only ever no-op while reading as a guard. The stamp above is the ONLY thing that
  // gives a child a role, so an un-stamped child judges nothing — which is the honest
  // shape: `PI_ENSEMBLE_CHILD_ROLE_ENV=0` is then the single switch for the whole set.
  assert.equal(
    existsSync(path.join(SRC, "child-role-env-hook.ts")),
    false,
    "the unreachable recovery module is gone, not merely unused",
  );
  assert.ok(
    !(await read("child-guards.ts")).includes("registerChildRoleEnv"),
    "the companion no longer wires a recovery that could never answer",
  );

  // The companion is installed by the real spawn path — proven by loading the
  // module the argv names, rather than an imitated fixture (which is what let the
  // inert guard survive: a test that builds its own env proves the fixture).
  const companion = path.join(SRC, "child-guards.ts");
  assert.ok(existsSync(companion), "the companion exists on disk");
  const loaded = spawnSync(
    process.execPath,
    [
      "-e",
      `const on=()=>{};import(${JSON.stringify(companion)}).then(m=>m.default({on,registerTool:on,registerCommand:on})).then(()=>console.log("ok")).catch(e=>{console.error(String(e));process.exit(2)});`,
    ],
    {
      env: {
        ...base,
        PI_ENSEMBLE_SUBAGENT_MODE: "1",
        [CHILD_ROLE_ENV]: "adversarial-developer",
        [CHILD_TMP_ENV]: base.PI_ENSEMBLE_CHILD_TMP,
      },
      encoding: "utf8",
    },
  );
  assert.equal(loaded.status, 0, `the companion loads in a child: ${loaded.stderr}`);
  assert.equal(loaded.stdout.trim(), "ok");
  rmSync(base.PI_ENSEMBLE_CHILD_TMP, { recursive: true, force: true });
  console.log("✓ B passed");
}

// ============================================================
// C. The judge table. A fixture home with a state dir, planted with files,
// and the reviewer's three probe shapes aimed at it — refused — beside the
// same commands aimed inside the roots, allowed.
// ============================================================
async function guardJudgeTable() {
  console.log("── C. judge table ──");
  const root = mkdtempSync(path.join(tmpdir(), "rf-2352-"));
  const home = path.join(root, "home");
  const worktree = path.join(root, "worktree");
  const project = path.join(home, "target");
  const state = path.join(project, ".state");
  const childTmp = path.join(root, "ct");
  // The child's scratch HOME is UNDER its per-spawn dir, and that home is where the
  // target project's live state sits in the field shape — a fixture whose home is
  // inside its own roots could never reproduce it, so home stays outside.
  const scratchHome = path.join(childTmp, "home");
  for (const d of [home, worktree, state, childTmp, scratchHome]) {
    await Bun.write(path.join(d, ".keep"), "");
  }
  await Bun.write(path.join(state, "memory.json"), "{}");
  const roots = reviewerRootsFrom({ [CHILD_TMP_ENV]: childTmp }, worktree);
  assert.deepEqual(
    roots.labels.sort(),
    [childTmp, worktree].sort(),
    "the roots are the child's cwd and its per-spawn dir, nothing else",
  );

  const refused = async (label: string, command: string) => {
    const hit = firstReviewerWriteOutside(command, roots);
    assert.ok(hit !== undefined, `refused: ${label}`);
    assert.ok(hit.reason.length > 20, `${label}: the refusal names a reason`);
  };
  const allowed = async (label: string, command: string) => {
    const hit = firstReviewerWriteOutside(command, roots);
    assert.equal(hit, undefined, `allowed: ${label}${hit ? ` — ${hit.reason}` : ""}`);
  };

  // The three shapes from the field, aimed at the target project's live state dir.
  await refused(
    "a move of the live state dir into scratch, restored by copy (the field shape)",
    `mv ${state} ${childTmp}/stashed && cp -a ${childTmp}/stashed ${project}/.state`,
  );
  await refused("a copy into the live tree", `cp a ${state}/b`);
  await refused("a recursive copy into the live tree", `cp -a x ${state}/`);
  await refused("a plant of files in the live tree", `touch ${state}/planted-1 ${state}/planted-2`);
  await refused("a symlink planted in the live tree", `ln -s ${childTmp}/x ${state}/link`);
  await refused("a delete inside the live tree", `rm ${state}/memory.json`);
  await refused("a recursive delete of the live tree", `rm -rf ${state}`);
  await refused("a name with a leading space", `touch "${state}/ sp ace"`);
  await refused(
    "an in-place interpreter edit in the live tree",
    `sed -i s/a/b/ ${state}/memory.json`,
  );
  await refused("a redirect into the operator's home", `printf '[user]' > ${home}/.gitconfig`);
  await refused("an append into the operator's home", `printf x >> ${home}/.bashrc`);
  await refused(
    "an interpreter one-liner that writes outside",
    `python3 -c "open('${state}/x','w')"`,
  );
  await refused("a heredoc into the live tree", `cat <<EOF > ${state}/note\nhi\nEOF`);
  await refused("a brace list at a write position", `touch ${state}/{a,b}`);
  await refused("a glob at a write position", `touch ${state}/*`);
  await refused("an unresolvable path (symlink loop)", `mv ${root}/loop ${state}/x`);
  await refused("a tar extracted into the live tree", `tar xf a.tgz -C ${state}`);
  await refused("a chmod inside the live tree", `chmod 777 ${state}/memory.json`);
  await refused("a run-time-built body (class (c) for a guarded verb)", `eval "cp a ${state}/b"`);
  await refused(
    "a command that does not lex at all (fail closed for a guarded verb)",
    `cp a ${state}/b '${""}`,
  );
  await refused("an unterminated subshell body", `bash -c "cp a ${state}/b`);

  // Class (b) and the class-(c) allowance: inside the roots, or no write verb.
  await allowed("reads the project it is auditing", `cat ${state}/memory.json`);
  await allowed("lists the project", `ls -la ${project}`);
  await allowed("greps it with a glob", `grep -rn 'x' ${project}/*.ts`);
  await allowed("its git status", `git -C ${project} status --porcelain`);
  await allowed("its git log", `git -C ${project} log --oneline -n 5`);
  await allowed("a make job flag", `make -j8`);
  await allowed("writes its own scratch", `touch ${childTmp}/notes.md`);
  await allowed("writes its own tree", `touch ${worktree}/finding.md`);
  await allowed("moves inside its tree", `mv ${worktree}/a ${worktree}/b`);
  await allowed("copies into its own tree", `cp ${state}/memory.json ${worktree}/copy.json`);
  await allowed("deletes inside its own tree", `rm ${worktree}/finding.md`);
  await allowed("a recursive delete inside its own tree", `rm -rf ${worktree}/build`);
  await allowed("redirects into its scratch", `echo hi > ${childTmp}/out.txt`);
  // The scratch HOME is under the per-spawn dir, so the child's own home IS one of
  // its roots — the whole point of the redirect (`reviewer-scratch-home.ts`), and
  // what makes `$HOME`-shaped writes land in scratch instead of the operator's tree.
  await allowed("writes the gitconfig the scratch HOME moved", `touch ${scratchHome}/.gitconfig`);
  await allowed(
    "writes under the scratch HOME's XDG state root",
    `mkdir -p ${scratchHome}/.local/state/foo`,
  );
  await allowed("an empty command", ``);
  await allowed("a command with no words", `:`);

  // The refusal text names the rule and the roots, and never the target.
  const hit = firstReviewerWriteOutside(`rm -rf ${state}`, roots);
  assert.ok(hit !== undefined);
  const text = reviewerRefusalText(roots, hit.reason);
  assert.ok(text.includes(worktree) && text.includes(childTmp), "the refusal names both roots");
  assert.ok(!text.includes(state), "the refusal never echoes the target path");
  assert.equal(hit.reason, REVIEWER_OUTSIDE_REASON);

  // The consequence, R6: one tool call refused, and no verdict touched. The
  // verdict fields are named here so the guard cannot grow into a judgement.
  const verdictFields = ["ok", "loopOutcome", "verdict", "approved", "severity"];
  for (const f of verdictFields) {
    assert.ok(
      !(await read("write-fence-reviewer.ts")).includes(`"${f}"`),
      `the guard never writes the verdict field ${f}`,
    );
  }
  rmSync(root, { recursive: true, force: true });
}

// ============================================================
// D. Registration gates: the role and the switch decide who is judged, and
// the hook blocks one call rather than failing the dispatch.
// ============================================================
async function registrationGates() {
  console.log("── D. registration gates ──");
  const root = mkdtempSync(path.join(tmpdir(), "rg-2352-"));
  const worktree = path.join(root, "wt");
  const childTmp = path.join(root, "ct");
  const outside = path.join(root, "home", "target");
  for (const d of [worktree, childTmp, outside]) await Bun.write(path.join(d, ".keep"), "");

  type Handler = (event: { toolName: string; input?: unknown }) => Promise<
    { block: boolean; reason?: string } | undefined
  >;
  const install = async (env: Record<string, string | undefined>) => {
    const hooks: Handler[] = [];
    const pi = {
      on: (_event: string, handler: Handler) => {
        hooks.push(handler);
      },
    };
    registerReviewerWriteGuard(pi as never, {
      env: { [CHILD_TMP_ENV]: childTmp, PI_ENSEMBLE_WRITE_SCRATCH: childTmp, ...env } as never,
      cwd: worktree,
    });
    return hooks;
  };

  const asReviewer = await install({ PI_ENSEMBLE_ROLE: "adversarial-developer" });
  assert.equal(asReviewer.length, 1, "a confined role registers the hook");
  const blocked = await asReviewer[0]({
    toolName: "bash",
    input: { command: `rm -rf ${outside}` },
  });
  assert.equal(blocked?.block, true, "one tool call is blocked");
  assert.ok(blocked?.reason?.startsWith("Refused:"), "with a reason the child can act on");
  const pass = await asReviewer[0]({
    toolName: "bash",
    input: { command: `git status --porcelain` },
  });
  assert.equal(pass, undefined, "an ordinary review command runs");
  assert.equal(
    await asReviewer[0]({ toolName: "read", input: { path: "/etc/passwd" } }),
    undefined,
    "only bash is judged",
  );
  assert.equal(
    await asReviewer[0]({ toolName: "bash", input: {} }),
    undefined,
    "a bash call with no command string is not this rule's to judge",
  );

  assert.equal(
    (await install({ PI_ENSEMBLE_ROLE: "developer" })).length,
    0,
    "a developer is the driver's fence to enforce, not this rule's",
  );
  assert.equal((await install({})).length, 0, "an unroled child registers nothing");
  assert.equal(
    (
      await install({
        PI_ENSEMBLE_ROLE: "code-review-specialist",
        PI_ENSEMBLE_REVIEWER_WRITE_GUARD: "0",
      })
    ).length,
    0,
    'PI_ENSEMBLE_REVIEWER_WRITE_GUARD=0 turns the guard off (the issue\'s "not a sandbox" sentence)',
  );

  // The refusal was recorded — R6 says counted, so the line must be on disk.
  const logged = readdirSync(childTmp).filter((f) => f.startsWith("write-fence-"));
  assert.ok(logged.length > 0, "the refusal is recorded in the write-fence channel");
  rmSync(root, { recursive: true, force: true });
}

await run();
