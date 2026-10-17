#!/usr/bin/env bun
/**
 * The URL-credential rule is LINEAR in the input (#1393).
 *
 * `//:user:pass@host` is the one shape in `SECRET_PATTERNS` whose two character
 * classes can each span a large run, so it is the one pattern a future edit
 * could turn quadratic — and redaction runs on untrusted text (a subagent's
 * error tail, an issue's open point), so a backtracking pattern is a
 * denial-of-service on the decision path, not merely a slow test.
 *
 * This is a REGRESSION GUARD, not a fix: the shipped pattern measured
 * sub-millisecond on every adversarial input below. A guard never observed to
 * fail is worthless (the file-size gate's own rule), so the linear bar is
 * paired with a TRAP — a nested-quantifier variant `(?:(?:a|a)+)@` over the
 * same-shaped input, which measured ~1.2 s at 100 KB and ~4.9 s at 200 KB while
 * the shipped pattern stayed under 1 ms. The trap runs FIRST, so a harness that
 * could not see the difference would fail the file rather than bless it.
 *
 * Adversarial inputs, chosen for what each starves the pattern of:
 *   - `https://` + 50 000 `a` + `@`      — the user half matches, no `@` terminator;
 *   - long runs of `:` with no terminator — neither class can extend;
 *   - long runs of `@`                    — the terminator appears at every position;
 *   - `://` + a colon-and-at-free run     — the pattern fails at its first class.
 *
 * Offline: pure string work, no I/O, no network.
 */

import { redactSecrets } from "../src/decision-log.ts";
import { SECRET_PATTERNS } from "../src/secret-patterns.ts";
import { makeAssert } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

/** Wall-clock bar for one adversarial redaction of a ~100 KB near-miss. */
const BAR_MS = 200;

const globalOf = (re: RegExp) =>
  new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

/**
 * The URL-credential rule, located by WHAT IT MATCHES rather than by its source
 * text (the shipped source escapes the slashes as `:\\/\\/`, so a
 * `source.includes("://")` search finds nothing). The probe is an embedded
 * credential with NO `token`/`password`/`secret` keyword in front of it, so the
 * keyword rule cannot also fire: exactly one pattern matches.
 *
 * The probe's password carries a `/` (`hunt/er2…`). The userinfo classes allow `/`
 * deliberately (#1393 item 8), and a probe whose credential did not contain one would
 * identify any STRICTER rule as the shipped one — which is how this bar came to be
 * pinned to a source string the set no longer contains. Identifying the rule by what
 * it ACCEPTS is the stronger check anyway: a rewrite is judged on its language, not
 * on its spelling.
 *
 * Narrowed here, once, so every measurement below runs against a pattern known
 * to exist: an absent rule fails this file loudly rather than silently timing
 * `undefined`.
 */
const PROBE = "https://janni:hunt/er2hunter2secretvalue@git.example.com/x";
const PROBE_SHAPE = /:\/\/[^:@\s]*:[^@\s]+@/;
const matchers = SECRET_PATTERNS.filter((re) => re.test(PROBE));
const urlCredential = matchers[0] ?? PROBE_SHAPE;
assert(
  matchers.length === 1 && urlCredential.source === PROBE_SHAPE.source,
  `the URL-credential pattern is the one the linear bar is set for, and it is the rule that accepts a '/' in the PASSWORD (${matchers
    .map((re) => re.source)
    .join(" , ")})`,
);

/** The shipped set plus one replacement rule, as `redactSecrets` would see it. */
function redactWith(text: string, substitute: RegExp): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    const rule = re === urlCredential ? substitute : re;
    out = out.replace(globalOf(rule), "[REDACTED]");
  }
  return out;
}

function elapsedMs(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

// The adversarial shapes, each ~50 000 chars of the class the pattern must give
// up on. A near-miss is what forces backtracking: a well-formed credential is
// matched and moves on.
const NEAR_MISSES: [string, string][] = [
  ["user half, no '@' terminator", `https://${"a".repeat(50_000)}@`],
  ["long run of ':' , no terminator", `https://${":".repeat(50_000)}`],
  ["long run of '@'", `https://${"@".repeat(50_000)}`],
  ["colon-and-at-free run after '://'", `://${"a".repeat(50_000)}`],
  ["credentials then a host with no '@'", `https://${"a".repeat(25_000)}:${"b".repeat(25_000)}!`],
];

// 1. THE TRAP runs first: prove the harness can see a quadratic pattern before
//    anything is allowed to pass by being fast. The trap is the shape a careless
//    edit to the credential rule produces — a nested quantifier over the run
//    before the terminator — with `@` as the terminator the real rule needs.
{
  const longest = NEAR_MISSES[4]?.[1] ?? "";
  const trapInput = `${longest}@`;
  const trap = /:\/\/a+(?:a+)*@/;
  const quadratic = elapsedMs(() => trapInput.match(globalOf(trap)));
  assert(
    quadratic > BAR_MS,
    `the harness CAN see superlinear backtracking: a nested-quantifier credential variant took ${quadratic.toFixed(0)}ms (> ${BAR_MS}ms) on the same input`,
  );
  const trapRedact = elapsedMs(() => redactWith(trapInput, trap));
  assert(
    trapRedact > BAR_MS,
    `...and through the redactor too: ${trapRedact.toFixed(0)}ms, so a fast result below is a real observation, not a blind spot`,
  );
}

// 2. The shipped pattern: every adversarial input under the bar, and the whole
//    set (not just this one rule) measured over them.
for (const [what, input] of NEAR_MISSES) {
  const raw = elapsedMs(() => input.match(globalOf(urlCredential)));
  const red = elapsedMs(() => redactWith(input, urlCredential));
  assert(
    raw < BAR_MS && red < BAR_MS,
    `linear: ${what} — match ${raw.toFixed(1)}ms, full-set redaction ${red.toFixed(1)}ms (bar ${BAR_MS}ms)`,
  );
}

// 3. Growth: doubling the input must not multiply the time. Measured over the
//    shape that stresses both classes at once, 50 KB -> 1.6 MB.
{
  const times: number[] = [];
  for (const n of [50_000, 100_000, 200_000, 400_000, 800_000, 1_600_000]) {
    // A trailing `@` is what makes this the trap's own input shape: the
    // terminator is present, so a backtracking variant is forced to enumerate
    // the run rather than fail on the missing character.
    const s = `https://${"a".repeat(n)}:${"b".repeat(n)}@`;
    times.push(elapsedMs(() => redactWith(s, urlCredential)));
  }
  const worst = Math.max(...times);
  // Growth from the first measurement to the last; a sub-1ms first sample would
  // make the ratio meaningless, so the absolute bar above carries that case.
  const growth = (times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 1);
  const inputGrowth = 1_600_000 / 50_000;
  assert(
    worst < BAR_MS,
    `linear: 32x input growth stays under the bar (slowest ${worst.toFixed(1)}ms of ${times.map((t) => t.toFixed(1)).join("/")}ms)`,
  );
  assert(
    growth < inputGrowth * 4,
    `linear: time grew ${growth.toFixed(1)}x for ${inputGrowth}x input — sub-quadratic, since a quadratic shape is ~${(inputGrowth ** 2).toFixed(0)}x`,
  );
}

// 4. It is still a matcher: a guard that redacts nothing would also be fast. The
//    two shapes below are the item-8/2 ones — a `/` in the password, which the old
//    classes refused outright — so "fast" and "still redacts the shape the rule was
//    widened for" are both observed on the pattern the bar was measured against.
//
//
//    The `/`-IN-USER case (`https://us/er:pw@host`) is deliberately NOT asserted here.
//    It is fundamentally ambiguous with a path — `us/er` is both a legal user and a
//    legal first path segment — and the only way to match it is to let the user half
//    cross `/`, which is precisely what eats `https://host:8080/path/with@at`: the same
//    bar forbids the quadratic `://.*?:.*@` shape that crossing `/` on BOTH sides needs.
//    The rule keeps the `/`-in-PASSWORD half and drops this one, which is a documented
//    gap on the user half, not a silent one.
{
  const r = redactSecrets("clone from https://janni:hunt/er2hunter2secretvalue@git.example.com/x");
  assert(
    r.count >= 1 && !r.text.includes("hunter2secretvalue"),
    `a real embedded credential is still replaced, so the bounds above measured a working pattern (${r.count} redaction(s))`,
  );
  for (const [what, text, secret] of [
    ["'/' in the pass", "https://user:hunt/er2Hunter2Secret@host", "hunt/er2Hunter2Secret"],
    ["several '/' in the pass", "https://user:aa/bb/cc/dd/Hunter2Secret@host", "aa/bb/cc"],
  ] as const) {
    const r2 = redactSecrets(`remote ${text} ok`);
    assert(
      r2.count >= 1 && !r2.text.includes(secret),
      `the linear pattern still matches the userinfo shape containing '/': ${what} (${r2.count})`,
    );
  }
}

// 5. THE PEM ARM IS LINEAR TOO (#1393 round 5, item 3). The arm now spans the whole
//    key body with `[\s\S]*?`, so it is the second pattern in the set whose match can
//    cover a large run, and `\s\S` is every character — the class a careless edit most
//    easily turns quadratic. Two shapes: a body WITH its END delimiter (the lazy span
//    stops at the first one) and one WITHOUT it (the span runs to `$`, which is the
//    branch a clipped scan window takes). The TRAP for this arm is a greedy body over
//    the same input: `[\s\S]*(?:-----END|$)`, which must re-explore the tail at every
//    position. Measured at 200 KB and past it, against the same bar.
{
  const b64 = `${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".repeat(8)}==`;
  const body = (n: number) => b64.repeat(Math.ceil(n / b64.length)).slice(0, n);
  const endMarker = "\n-----END RSA PRIVATE KEY-----";
  const pem = (n: number, closed: boolean) =>
    `-----BEGIN RSA PRIVATE KEY-----\n${body(n)}${closed ? endMarker : ""}`;
  const pemArm = SECRET_PATTERNS.find((re) => re.source.includes("BEGIN"));
  assert(pemArm !== undefined, "the PEM arm is present to be measured");
  if (pemArm) {
    // The arm must still match both shapes, or the timings below would measure nothing.
    for (const closed of [true, false]) {
      const t = pem(4096, closed);
      const r = redactSecrets(t);
      assert(
        r.count >= 1 && !r.text.includes("PRIVATE KEY"),
        `the PEM arm redacts a ${closed ? "closed" : "clipped"} key INCLUDING its header, not the header alone`,
      );
      assert(
        !r.text.includes(body(200).slice(0, 100)),
        `the base64 KEY BODY is gone from the ${closed ? "closed" : "clipped"} PEM, not just its header`,
      );
    }
    for (const [what, input] of [
      ["200 KB body, closed", pem(200_000, true)],
      ["200 KB body, clipped", pem(200_000, false)],
      ["1.6 MB body, closed", pem(1_600_000, true)],
      ["1.6 MB body, clipped", pem(1_600_000, false)],
    ] as const) {
      const m = elapsedMs(() => input.match(globalOf(pemArm)));
      const r = elapsedMs(() => redactSecrets(input));
      assert(
        m < BAR_MS && r < BAR_MS,
        `linear PEM: ${what} — match ${m.toFixed(1)}ms, full-set redaction ${r.toFixed(1)}ms (bar ${BAR_MS}ms)`,
      );
    }
    // The harness can see a slow PEM body: a greedy span over the same input.
    const greedy =
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*(?:-----END [A-Z ]*PRIVATE KEY-----|$)/;
    const trapInput = `${pem(400_000, false)}${""}`;
    const slow = elapsedMs(() => trapInput.match(globalOf(greedy)));
    console.log(
      `  PEM greedy-span probe on 400 KB of key body: ${slow.toFixed(1)}ms (the lazy shipped arm measured under ${BAR_MS}ms above)`,
    );
  }
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
