#!/usr/bin/env bun
/**
 * #1764 phase 2 — the half of the path guard that is not a substring match.
 *
 * `test-review-state-guard.ts` holds the guard's contract: what it refuses and,
 * more importantly, what it must leave alone. This file holds the three
 * round-1 properties about HOW it decides, which are about the mechanism rather
 * than the verdict table:
 *
 *   B3  the cheap pass — the raw lowercased text is asked first, and the
 *       expensive views (an assignment scan plus two backslash strips) exist only
 *       when that misses and the text could contain something they would change;
 *   B4  the failure boundary is PER BRANCH — a fault inside the bash scan
 *       refuses that bash call and nothing else, and one inside the edit scan
 *       refuses that edit call. A guard that failed globally on its own bug is
 *       the misfire this module was rewritten to end;
 *   B5  the roots are a REQUIRED argument, so the guard answers from the roots it
 *       was GIVEN — a fixture that moves PI_AGENT_DIR cannot be judged against a
 *       cached root, and neither can production after a config change.
 *
 * Like its sibling, the store's name and the state leaf are BUILT from the
 * modules rather than spelled, so a suite that runs against the pre-relocation
 * guard can still be run.
 */

import {
  editsReviewState,
  namesReviewState,
  reviewStateRefusal,
  reviewStateRoots,
} from "../src/review-accept-guard.ts";
import { STATE_LEAF, FINDINGS_FILE } from "../src/review-state-path.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`PASS ${msg}`);
  else {
    console.error(`FAIL ${msg}`);
    exit = 1;
  }
}

const ROOTS = reviewStateRoots();
const RESOLVED = ROOTS[0] ?? "";
const STORE_FILE = FINDINGS_FILE;
const D = String.fromCharCode(36);
void D; // the dollar sign, spelled so a row below stays data
// ── 7. the cheap pass, the per-branch failure boundary, and the roots contract ──

// B3: the raw lowercased text is asked first, and the expensive views (an
// assignment scan plus two backslash strips) are built only when it misses AND the
// text carries an `=` or a backslash. A command with neither must still be judged —
// and judged the same way — so behaviour is asserted to be identical while the
// shape that would need those views is absent.
assert(
  namesReviewState("git status --porcelain", ROOTS) === undefined &&
    namesReviewState(`ls ~/.pi/agent/${STATE_LEAF}`, ROOTS) !== undefined,
  "cheap pass: a plain command and a store-naming command are both judged with no = or backslash present",
);
assert(
  namesReviewState(`echo a${D}b`, ROOTS) === undefined,
  "cheap pass: a dollar sign alone is not an assignment and is not a store path",
);

// B4: each branch fails closed only for ITSELF. A fault inside the edit scan must
// not refuse a bash call, and a fault inside the bash scan must not refuse an edit.
// The fault is induced with a getter that throws on the argument the branch reads.
{
  const boom = {
    get command(): string {
      throw new Error("hostile getter");
    },
  };
  // A throwing `command` getter is a scan that cannot run: that bash call is
  // refused, and nothing else is.
  assert(
    reviewStateRefusal("bash", boom) !== undefined,
    "branch isolation: a bash scan that cannot run refuses that bash call",
  );
  assert(
    reviewStateRefusal("edit", { path: "/repo/src/a.ts" }) === undefined,
    "branch isolation: a fault in the bash branch does not touch an edit call",
  );
  assert(
    reviewStateRefusal("write", { path: "/repo/src/a.ts" }) === undefined,
    "branch isolation: a fault in the bash branch does not touch a write call",
  );
  const editBoom = {
    get path(): string {
      throw new Error("hostile path getter");
    },
  };
  assert(
    reviewStateRefusal("edit", editBoom) !== undefined,
    "branch isolation: an edit scan that cannot run refuses that edit call",
  );
  assert(
    reviewStateRefusal("bash", { command: "git status" }) === undefined,
    "branch isolation: a fault in the edit branch does not refuse an ordinary bash call",
  );
}

// B5: `roots` is a REQUIRED parameter — a call without it is a type error, and the
// guard must answer from the roots it was GIVEN, not from whatever the environment
// happens to say. An unrelated root list refuses nothing, and one that names a
// made-up directory refuses exactly that directory.
{
  const FAKE = `/no/such/agent/${STATE_LEAF}-fixture`;
  assert(
    namesReviewState(`cat ${FAKE}/k/x.json`, [FAKE]) !== undefined,
    "roots are honoured: a caller-supplied root is the thing refused",
  );
  assert(
    namesReviewState(`cat ${FAKE}/k/x.json`, ["/unrelated/root"]) === undefined,
    "roots are honoured: the same text is nothing at all under a different root list",
  );
  assert(
    editsReviewState("write", { path: `${FAKE}/k/x.json` }, [FAKE]) !== undefined,
    "roots are honoured for edits: a target under the supplied root is refused",
  );
  assert(
    editsReviewState("write", { path: `${FAKE}/k/x.json` }, ["/unrelated/root"]) === undefined,
    "roots are honoured for edits: the same target runs under a different root list",
  );
}

// The roots themselves: the resolved spelling is the state root (agent dir PLUS
// the leaf), and a sibling directory whose name merely starts with a root is not
// it — the path-boundary rule in both branches.
assert(
  ROOTS.every((r) => r.endsWith(STATE_LEAF)),
  "every root names the state leaf, so the guard and the store cannot drift",
);
assert(
  namesReviewState(`cat ${RESOLVED}x/k/x.json`, ROOTS) === undefined,
  "boundary: a directory whose name only starts with the resolved root is not the root",
);

process.exit(exit);
