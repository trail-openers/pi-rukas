#!/usr/bin/env bun
/**
 * #1847 — `childHasExited` is the ONE liveness signal, so it is tested directly.
 *
 * Every supervisor of a spawn asks it before killing: the caps stack
 * (`spawn-caps.ts`), the per-child bound (`spawn-child-bound.ts`'s `gone()`) and
 * the skill re-read cap (through `observeReviewBounds`'s `targets.exited()`).
 * Until now the only evidence it worked was the behaviour of those three, which
 * means a defect in the predicate itself shows up as three puzzling supervisor
 * bugs rather than one failing assertion.
 *
 * Four shapes, because the predicate ORs two independent halves and each half
 * has to be able to decide on its own:
 *
 *   1. the kill flags' accessor true  → exited, even with a handle that still
 *      looks alive. That window is real: `armCapSession` sets the flag on `close`
 *      while `exitCode` may settle at `exit` (or the reverse), and the cap-kill
 *      grace interval is exactly where the two disagree.
 *   2. the accessor false but `exitCode` set → exited (a child whose exit status
 *      Node already knows, with no `armCapSession` behind it).
 *   3. the accessor false but `signalCode` set → exited (a child killed by a
 *      signal: `exitCode` stays null, so a predicate that read only the exit code
 *      would keep calling a SIGTERMed child alive).
 *   4. both null, accessor false → ALIVE. This is the shape a running child has,
 *      and the one a predicate that inverted its test would get wrong.
 *
 * Shape 4 also pins the `undefined` case: a test fake that omits both fields
 * entirely must read as alive, NOT exited — Node's contract is
 * `number | string | null`, and an exact-`null` comparison would call every
 * minimal fake exited and leave the bound under test unkillable, which is the
 * green-nothing failure the docstring on `childHasExited` warns about.
 */

import type { ChildProcess } from "node:child_process";
import { childHasExited } from "../src/spawn-support.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A child handle with only the two fields the predicate reads. Fields left
 * out of `over` are OMITTED, not set to null — the distinction shape 4 pins. */
function fake(over: { exitCode?: number | null; signalCode?: string | null } = {}) {
  return { ...over } as unknown as ChildProcess;
}
const flags = (childExited: boolean) => ({ childExited: () => childExited });

// (1) the kill flags decide on their own, over a handle that still looks alive.
assert(
  childHasExited(flags(true), fake({ exitCode: null, signalCode: null })) === true,
  "(1) the accessor's true is enough — the handle never has to agree",
);
// (2) with no flags behind the call, `exitCode` alone decides.
assert(
  childHasExited(flags(false), fake({ exitCode: 0, signalCode: null })) === true,
  "(2) a set exitCode means exited even when the accessor says false",
);
assert(
  childHasExited(undefined, fake({ exitCode: 1, signalCode: null })) === true,
  "(2) …and with no kill flags at all (a caller that never ran armCapSession)",
);
// (3) a signal-killed child: exitCode stays null, signalCode carries the truth.
assert(
  childHasExited(flags(false), fake({ exitCode: null, signalCode: "SIGTERM" })) === true,
  "(3) a signalCode means exited, whatever exitCode says — the SIGTERM case",
);
// (4) nothing has happened to this child: it is ALIVE, and must stay killable.
assert(
  childHasExited(flags(false), fake({ exitCode: null, signalCode: null })) === false,
  "(4) both halves null with the accessor false → alive",
);
assert(
  childHasExited(undefined, fake()) === false,
  "(4) a fake that OMITS both fields is alive, not exited (an exact-null test would be a suite of green nothing)",
);
// Canary: the accessor's false is not read as "exited" the way its true is.
assert(
  childHasExited(flags(false), fake()) === false,
  "(4) canary: an explicit false accessor plus an untouched handle is alive, so (1) is the accessor's true deciding and not an always-true predicate",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
