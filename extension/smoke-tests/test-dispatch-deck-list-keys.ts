#!/usr/bin/env bun
/**
 * #914 — key collision test and stop-all key regression (extracted verbatim
 * from test-dispatch-deck-list.ts sections 10 and 11 when the parent hit
 * the 500-line file limit).
 *
 * Section 10: the chosen list shortcut is UNBOUND in BOTH tables Pi
 * resolves — the installed pi-tui table (getKeybindings) AND the
 * pi-coding-agent KEYBINDINGS (app.* ids). The control assertion proves
 * `ctrl+l` IS detected as bound in the app table (where app.model.select
 * owns it), so the test cannot pass vacuously.
 *
 * Section 11: stop-all key regression — `matchesKey("x", STOP_ALL_KEY)`
 * must be false (a plain x never fires the stop-all key); the Kitty
 * shift+x wire form `\x1b[120;2u` (codepoint 120 = 'x', mod 2 = shift)
 * matches.
 */

import { STOP_ALL_KEY, LIST_SHORTCUT } from "../src/agent-list-keys.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// 10. Key collision test: the chosen list shortcut is UNBOUND in BOTH
//     tables Pi resolves — the installed pi-tui table (getKeybindings)
//     AND the pi-coding-agent KEYBINDINGS (app.* ids). The control
//     assertion proves `ctrl+l` IS detected as bound in the app table
//     (where app.model.select owns it), so the test cannot pass
//     vacuously. The in-list stop-all key `X` (shift+x) is not a
//     global binding: `ctrl+x` is bound (app.message.copy) but `X`
//     (shift+x) is not — a plain `x` (kill-one) and `ctrl+x` (copy)
//     are distinct from `X` in pi-tui's key matcher (a plain `x` never
//     fires the stop-all key — `matchesKey("x", "shift+x")` is false,
//     verified in section 11 below).
// ---------------------------------------------------------------------------
{
  const { getKeybindings } = await import("@earendil-works/pi-tui");
  // pi-coding-agent's app-level keybindings (app.* ids). The module is not
  // re-exported from the package root, so we import it via a relative path
  // from the installed package's dist directory.
  const { KEYBINDINGS: APP_KB } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");
  const kb = getKeybindings();
  const tui = kb.getResolvedBindings() as Record<string, string | string[] | undefined>;
  const app = APP_KB as Record<string, { defaultKeys: string | string[] }>;
  // Collect all bound keys from BOTH tables.
  const allBound: string[] = [];
  for (const v of Object.values(tui)) {
    if (Array.isArray(v)) allBound.push(...v);
    else if (typeof v === "string") allBound.push(v);
  }
  for (const d of Object.values(app)) {
    if (Array.isArray(d.defaultKeys)) allBound.push(...d.defaultKeys);
    else if (typeof d.defaultKeys === "string") allBound.push(d.defaultKeys);
  }
  // Control assertion: `ctrl+l` IS bound in the app table (app.model.select).
  // This proves the test is actually reading the app table — without it,
  // a bug that made the app table unreadable would let the unbound check
  // pass vacuously.
  assert(
    allBound.includes("ctrl+l"),
    "10-control: `ctrl+l` IS detected as bound in the app table (app.model.select) — the test reads both tables",
  );
  assert(
    !allBound.includes(LIST_SHORTCUT),
    `10a: list shortcut ${LIST_SHORTCUT} is UNBOUND in BOTH tables (pi-tui + pi-coding-agent)`,
  );
  // The in-list stop-all key `X` (shift+x) is not a global binding.
  assert(
    !allBound.includes(STOP_ALL_KEY),
    `10b: stop-all key ${STOP_ALL_KEY} (shift+x) is UNBOUND globally`,
  );
  // The global `ctrl+x` IS bound (app.message.copy) — this is the collision
  // that motivated the original chord. The chord is now removed; `X`
  // (shift+x) is in-list-only and does not collide.
  assert(
    allBound.includes("ctrl+x"),
    "10c: `ctrl+x` IS bound globally (app.message.copy) — the collision the original chord was chosen to avoid",
  );
  const conflicts = kb.getConflicts();
  assert(Array.isArray(conflicts), "10d: getConflicts() returns a list (the manager is live)");
}

// ---------------------------------------------------------------------------
// 11. Stop-all key regression: a plain `x` (kill-one) NEVER fires the
//     stop-all key; the Kitty shift+x wire form DOES fire it.
//     `matchesKey("x", STOP_ALL_KEY)` must be false — this is what the
//     #914 "case-sensitive" claim was imprecisely about: the distinction
//     is in the key data, not a case rule. The Kitty wire form
//     `\x1b[120;2u` (codepoint 120 = 'x', mod 2 = shift) is the shape
//     pi-tui's Kitty-mode parser produces for shift+x and must match.
// ---------------------------------------------------------------------------
{
  const { matchesKey } = await import("@earendil-works/pi-tui");
  assert(
    matchesKey("x", STOP_ALL_KEY) === false,
    "11a: matchesKey('x', STOP_ALL_KEY) === false (a plain x never fires the stop-all key)",
  );
  assert(
    matchesKey("\x1b[120u", STOP_ALL_KEY) === false,
    "11b: matchesKey('\x1b[120u', STOP_ALL_KEY) === false (Kitty unmodified x does not match shift+x)",
  );
  assert(
    matchesKey("\x1b[120;2u", STOP_ALL_KEY) === true,
    "11c: matchesKey('\x1b[120;2u', STOP_ALL_KEY) === true (Kitty shift+x wire form matches)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
