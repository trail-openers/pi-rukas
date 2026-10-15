#!/usr/bin/env bun
/**
 * The adversarial fix pass and comments it did not simply delete (split from
 * test-work-driver-adversarial-fix-pass.ts to keep both under the file-size
 * gate). A reworded comment, and a comment an earlier develop pass removed, are
 * the reviewers' call and must not park the fix pass; an outright removal still
 * parks (case G in the sibling file).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import { devCommit, fixCtx, fixState, git, repoWithFile } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

// G2 — a comment reworded in place never reappears verbatim. That is the
// reviewers' call, not a park. G3 — nor is a comment an EARLIER pass removed:
// the diff is against the base, so it carries that removal into every fix pass.
{
  const x = path.join("extension", "src", "x.ts");
  const withComment =
    "export const x = 1;\n// the parser lives in the doors row\nexport const y = 2;\n";
  const cases = [
    {
      label: "G2: a fix pass that rewords an origin/main comment is applied",
      firstPass: undefined,
      fix: "export const x = 1;\n// the parser lives in the header band\nexport const y = 2;\n",
    },
    {
      label: "G3: a comment the first develop pass removed does not park the fix pass",
      firstPass: "export const x = 1;\nexport const y = 2;\n",
      fix: "export const x = 3;\nexport const y = 2;\n",
    },
  ];
  for (const c of cases) {
    const dir = repoWithFile("fix-reword");
    try {
      mkdirSync(path.join(dir, "extension", "src"), { recursive: true });
      writeFileSync(path.join(dir, x), withComment);
      git(dir, "add -A");
      git(dir, 'commit -q -m "add x"');
      const st = fixState(dir, ["extension/src/x.ts"], "extension/src/x.ts: fix it");
      if (c.firstPass) devCommit(dir, x, c.firstPass);
      const ctx = fixCtx(dir, () => devCommit(dir, x, c.fix));
      const out = await runAdversarialFixPass(ctx, st, pendingFixes(st.eventLog), Date.now());
      const tail = out.eventLog[out.eventLog.length - 1];
      const why = tail?.kind === "cap-hit" ? tail.evidence : tail?.kind;
      assert(tail?.kind === "adversarial-fix-applied", `${c.label} (tail: ${why})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
