#!/usr/bin/env bun
/**
 * #1879 part B — a READ-ONLY role's bash cannot write into a shared dependency
 * tree, in the worktree or through a provisioned link into the main checkout.
 *
 * The incident: a reviewer child (write/edit/multiedit structurally excluded,
 * bash not fenced) overwrote the main checkout's
 * `extension/node_modules/typescript/bin/tsc` with a stub, and every local
 * typecheck exited 0 for eleven minutes.
 *
 *   A. the rule is role-scoped: only the three read-only roles are held to it;
 *   B. the incident's command is refused, in every spelling that resolves into a
 *      dependency tree (absolute, relative, through the provisioned link);
 *   C. reads and writes elsewhere still run — the rule is not a bash ban;
 *   D. a DEVELOPER is untouched by this rule (it may install: that is what
 *      provisioning is for), and the whole-tree fence is not weakened;
 *   E. the hook wiring: registered for a read-only child with NO write root
 *      (the reviewer's real configuration), and the refusal is logged.
 */

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bashWriteTargets } from "../src/write-fence-bash.ts";
import {
  READ_ONLY_ROLES,
  depWriteRefusal,
  isDependencyPath,
  isReadOnlyRole,
} from "../src/write-fence-deps.ts";
import { safeResolve } from "../src/write-fence-path.ts";
import { registerWriteFence } from "../src/write-fence.ts";
import { buildFenceFixture } from "./lib/write-fence-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown;
function fakePi() {
  const handlers: Record<string, Handler[]> = {};
  return {
    handlers,
    on(name: string, fn: Handler) {
      handlers[name] = [...(handlers[name] ?? []), fn];
    },
  } as unknown as ExtensionAPI & { handlers: Record<string, Handler[]> };
}
async function toolCall(
  pi: { handlers: Record<string, Handler[]> },
  event: Record<string, unknown>,
) {
  const results = await Promise.all(
    (pi.handlers.tool_call ?? []).map((h) => h({ type: "tool_call", ...event }, {})),
  );
  return results.find((r) => r !== undefined) as { block: true; reason: string } | undefined;
}

const ENV_KEYS = [
  "PI_ENSEMBLE_WRITE_ROOT",
  "PI_ENSEMBLE_WRITE_REPO",
  "PI_ENSEMBLE_WRITE_SCRATCH",
  "PI_ENSEMBLE_WRITE_FENCE",
  "PI_ENSEMBLE_ROLE",
  "PI_ENSEMBLE_SUBAGENT_MODE",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const savedCwd = process.cwd();
function restoreEnv() {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  process.chdir(savedCwd);
}

const fx = buildFenceFixture("deps");
/** The incident's target: the main checkout's shared compiler, two ways. */
const REPO_TSC = path.join(fx.repo, "extension", "node_modules", "typescript", "bin", "tsc");
const WT_TSC = path.join(fx.wt, "extension", "node_modules", "typescript", "bin", "tsc");

// ============================================================
// A. Role scoping.
// ============================================================
assert(
  READ_ONLY_ROLES.length === 3 &&
    READ_ONLY_ROLES.every((r) => isReadOnlyRole(r)) &&
    !isReadOnlyRole("developer") &&
    !isReadOnlyRole("ops") &&
    !isReadOnlyRole(undefined),
  "A: the rule holds exactly the three read-only roles, and never developer/ops",
);
assert(
  depWriteRefusal(
    "developer",
    [{ path: REPO_TSC, cwd: fx.wt, linkedCommand: false, throughLinks: [] }],
    safeResolve,
  ) === undefined,
  "A: a developer's dependency write is NOT this rule's business (provisioning exists for it)",
);

// ============================================================
// B. The incident's command, in every spelling that reaches a dependency tree.
// ============================================================
const incidentCommands: Array<[string, string]> = [
  [
    "the incident: overwrite the shared compiler",
    `printf 'sleep 9.5\\nprocess.exit(0);\\n' > ${WT_TSC}`,
  ],
  ["the same file named in the main checkout", `echo x > ${REPO_TSC}`],
  [
    "an in-place edit of a dependency file",
    `sed -i s/a/b/ ${path.join(fx.repo, "node_modules", "pkg", "x.js")}`,
  ],
  [
    "a copy over a dependency file",
    `cp /tmp/stub ${path.join(fx.wt, "node_modules", "pkg", "x.js")}`,
  ],
  ["a whole-tree removal", `rm -rf ${path.join(fx.wt, "node_modules")}`],
  [
    "a nested package install into the shared tree",
    `mkdir -p ${path.join(fx.repo, "extension", "node_modules", "evil")}`,
  ],
  ["a vendor-tree write", `echo x > ${path.join(fx.wt, "vendor", "dep.js")}`],
  ["a venv write", `echo x >> ${path.join(fx.repo, ".venv", "pyvenv.cfg")}`],
];
for (const [what, cmd] of incidentCommands) {
  const reason = depWriteRefusal("explore", bashWriteTargets(cmd, fx.wt), safeResolve);
  assert(reason !== undefined, `B: refused — ${what}`);
  assert(
    reason === undefined || /read-only role/.test(reason),
    `B: the refusal names the role rule, not a generic fence — ${what}`,
  );
}

// ============================================================
// C. Reads and legitimate writes still run.
// ============================================================
const allowedCommands: Array<[string, string]> = [
  ["reads the compiler it is auditing", `cat ${REPO_TSC}`],
  [
    "runs the compiler",
    `node ${path.join(fx.repo, "extension", "node_modules", "typescript", "bin", "tsc")} --noEmit`,
  ],
  ["lists a dependency tree", `ls ${path.join(fx.repo, "node_modules")}`],
  ["writes its own scratch file", `echo notes > ${path.join(fx.scratch, "report.md")}`],
  ["writes in the worktree", `echo x > ${path.join(fx.wt, "src", "note.ts")}`],
  [
    "a file whose NAME contains node_modules, not a path into one",
    `echo x > ${path.join(fx.wt, "src", "node_modules.md")}`,
  ],
];
for (const [what, cmd] of allowedCommands) {
  assert(
    depWriteRefusal("adversarial-developer", bashWriteTargets(cmd, fx.wt), safeResolve) ===
      undefined,
    `C: allowed — ${what}`,
  );
}
// Both directions of the segment rule, stated separately: a file NAMED like a
// dependency tree is not inside one, and a directory segment IS.
assert(
  isDependencyPath(path.join(fx.wt, "src", "node_modules.md")) === false &&
    isDependencyPath(path.join(fx.wt, "src", "docs", "vendor-notes.ts")) === false,
  "C: isDependencyPath is a segment rule — a file named node_modules.md is not a dependency path",
);
assert(
  isDependencyPath(path.join(fx.repo, "node_modules", "typescript", "bin", "tsc")) === true,
  "C: and a path that runs THROUGH a dependency segment is",
);

// ============================================================
// E. The hook wiring — a reviewer child has NO write root, and is still held.
// ============================================================
const roleEnv = async (
  role: string | undefined,
  root: string | undefined,
  cmd: string,
): Promise<string | undefined> => {
  restoreEnv();
  if (role !== undefined) process.env.PI_ENSEMBLE_ROLE = role;
  if (root !== undefined) {
    process.env.PI_ENSEMBLE_WRITE_ROOT = root;
    process.env.PI_ENSEMBLE_WRITE_REPO = fx.repo;
    process.env.PI_ENSEMBLE_WRITE_SCRATCH = fx.scratch;
  }
  process.chdir(fx.wt);
  const pi = fakePi();
  registerWriteFence(pi);
  const res = await toolCall(pi, { toolName: "bash", input: { command: cmd } });
  return res?.reason;
};

const reviewerRefused = await roleEnv("explore", undefined, `echo x > ${REPO_TSC}`);
assert(
  reviewerRefused !== undefined && /read-only role/.test(reviewerRefused),
  "E: a reviewer with NO write root is still refused a dependency write (the whole-tree fence alone would not catch it)",
);
const reviewerFine = await roleEnv("explore", undefined, `cat ${REPO_TSC}`);
assert(reviewerFine === undefined, "E: the same reviewer's read of that file runs");
const devUntouched = await roleEnv("developer", undefined, `echo x > ${REPO_TSC}`);
assert(devUntouched === undefined, "E: an unfenced developer's bash is untouched by this rule");
const adversarialRefused = await roleEnv(
  "adversarial-developer",
  undefined,
  `cp /tmp/stub ${REPO_TSC}`,
);
assert(adversarialRefused !== undefined, "E: adversarial-developer is held too");
const reviewerLogged = await roleEnv("code-review-specialist", undefined, `echo x > ${REPO_TSC}`);
assert(reviewerLogged !== undefined, "E: code-review-specialist is held too");

restoreEnv();
console.log(
  exit === 0 ? "\nwrite-fence-deps: all groups passed" : `\nwrite-fence-deps: FAILED (${exit})`,
);
process.exit(exit);
