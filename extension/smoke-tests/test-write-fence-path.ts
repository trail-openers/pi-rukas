#!/usr/bin/env bun
/**
 * #1655 — the write fence's path rule (write-fence-path.ts), against a real
 * on-disk layout (smoke-tests/lib/write-fence-fixture.ts).
 *
 * Every case is a write a developer child could make, judged the way the OS
 * would resolve it. The table covers each acceptance criterion's path form and
 * the two operator-resolved edge cases: a `..` after a provisioned link climbs
 * out of the dependency tree, and a symlink other than a provisioned link is
 * refused.
 */

import { rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type FenceConfig,
  isInside,
  judgeWrite,
  loadFenceConfig,
  resolveLikeOs,
} from "../src/write-fence-path.ts";
import { buildFenceFixture } from "./lib/write-fence-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fx = buildFenceFixture("path");
symlinkSync(path.join(fx.wt, "loop"), path.join(fx.wt, "loop"));
const loaded = loadFenceConfig({
  PI_ENSEMBLE_WRITE_ROOT: fx.wt,
  PI_ENSEMBLE_WRITE_SCRATCH: fx.scratch,
});
if (!loaded) throw new Error("fixture config did not load");
const cfg: FenceConfig = loaded;

/** Does the rule allow `target` written from `cwd`? */
function allowed(target: string, cwd: string = fx.wt, c: FenceConfig = cfg): boolean {
  return judgeWrite(target, cwd, c).ok;
}

// ------------------------------------------------ inside the worktree: allowed
assert(allowed("src/a.ts"), "allow: a relative file inside the worktree");
assert(
  allowed(path.join(fx.wt, "src", "new", "deep", "a.ts")),
  "allow: a new file under missing dirs",
);
assert(allowed("node_modules/pkg/new.js"), "allow: through the provisioned root node_modules link");
assert(
  allowed("extension/node_modules/pkg/new.js"),
  "allow: through the provisioned depth-1 node_modules link",
);
assert(allowed(path.join(fx.scratch, "log.md")), "allow: the cycle scratch dir");
assert(allowed(path.join(os.tmpdir(), "fence-check")), "allow: the OS temp dir");
assert(allowed("/tmp/fence-check"), "allow: /tmp (a realpath'd temp dir)");

// ------------------------------------------- outside the worktree: refused
assert(!allowed("../../bin/keep"), "refuse: a relative ../ path to the repo root");
assert(!allowed(path.join(fx.repo, "bin", "new")), "refuse: an absolute path into the repo root");
assert(
  !allowed(path.join(fx.repo, "node_modules", "pkg", "new.js")),
  "refuse: a direct write to the repo root's node_modules",
);
assert(!allowed(path.join(fx.other, "f")), "refuse: a sibling worktree");
assert(!allowed("../other/f"), "refuse: a ../ path to a sibling worktree");
assert(!allowed("missing/../../../x"), "refuse: a ../ through a missing dir that climbs out");
assert(!allowed("out/x"), "refuse: a symlink in the worktree that points at the repo root");

// --------------------------- the operator-resolved edge cases (see the issue)
assert(
  !allowed("node_modules/../bin/x"),
  "refuse: `<worktree>/node_modules/../bin/x` — the OS resolves it to <repo>/bin/x, outside the dependency tree",
);
assert(
  // Concatenated, not path.join: join would normalise the `..` away before the resolver sees it.
  resolveLikeOs(`${fx.wt}/node_modules/..`) === fx.repo,
  "canary: the OS-style resolver follows the link before `..` (lexical normalisation would say the worktree)",
);
assert(
  !allowed("node_modules/../../x"),
  "refuse: a `..` climbing from a dependency link past the repo root",
);

// ------------------------------------------- a link the worktree did not provision
const wt2Cfg = loadFenceConfig({
  PI_ENSEMBLE_WRITE_ROOT: fx.wt2,
  PI_ENSEMBLE_WRITE_SCRATCH: fx.scratch,
});
if (!wt2Cfg) throw new Error("wt2 config did not load");
assert(
  !allowed("node_modules/new", fx.wt2, wt2Cfg),
  "refuse: a node_modules link whose target is not named node_modules (not a provisioned dependency tree)",
);

// ------------------------------------------------ a loop is refused, never hung on
assert(!allowed("loop/x"), "refuse: a self-referencing symlink loop (resolution fails closed)");

// ------------------------------------------------ the refusal names the path and the root
{
  const refusal = judgeWrite("../../bin/keep", fx.wt, cfg);
  assert(!refusal.ok, "message: the repo-root write is refused");
  if (!refusal.ok) {
    assert(refusal.message.includes("../../bin/keep"), "message: names the attempted path");
    assert(refusal.message.includes(fx.wt), "message: names the write root");
    assert(
      !refusal.message.includes("scratch") && !refusal.message.includes("temp"),
      "message: says nothing of the scratch or temp allowances",
    );
  }
}

// ------------------------------------------------ an unusable root fails closed
for (const [label, root] of [
  ["set but empty", ""],
  ["relative", "wt"],
  ["nonexistent", path.join(fx.base, "no-such-worktree")],
] as const) {
  const broken = loadFenceConfig({
    PI_ENSEMBLE_WRITE_ROOT: root,
    PI_ENSEMBLE_WRITE_SCRATCH: fx.scratch,
  });
  if (!broken) throw new Error(`unusable-root config (${label}) did not load`);
  assert(
    !allowed("src/a.ts", fx.wt, broken),
    `fail-closed: ${label} root refuses a worktree write`,
  );
  assert(
    !allowed(path.join(fx.repo, "bin", "x"), fx.wt, broken),
    `fail-closed: ${label} root refuses the repo root`,
  );
  assert(
    allowed(path.join(fx.scratch, "log.md"), fx.wt, broken),
    `fail-closed: ${label} root still allows scratch`,
  );
  assert(
    allowed("/tmp/fence-check", fx.wt, broken),
    `fail-closed: ${label} root still allows temp`,
  );
  const refusal = judgeWrite("src/a.ts", fx.wt, broken);
  assert(
    !refusal.ok && refusal.message.includes("unusable"),
    `fail-closed: ${label} root refusal says the root is unusable`,
  );
}

// ------------------------------------------------ the fence is off without a root
assert(loadFenceConfig({}) === undefined, "off: no PI_ENSEMBLE_WRITE_ROOT → no fence");
assert(
  loadFenceConfig({ PI_ENSEMBLE_WRITE_ROOT: fx.wt, PI_ENSEMBLE_WRITE_FENCE: "0" }) === undefined,
  "off: PI_ENSEMBLE_WRITE_FENCE=0 is the escape hatch",
);

// ------------------------------------------------ isInside is containment, not prefix
assert(isInside("/a/b", "/a/b"), "isInside: a path is inside itself");
assert(isInside("/a/b/c", "/a/b"), "isInside: a child is inside its parent");
assert(!isInside("/a/bc", "/a/b"), "isInside: a sibling sharing a name prefix is not inside");

rmSync(fx.base, { recursive: true, force: true });
if (exit === 0) console.log("✓ all write-fence path-rule assertions passed");
process.exit(exit);
