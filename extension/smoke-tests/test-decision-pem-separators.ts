import { REDACTED, redactBounded, redactSecrets } from "../src/decision-log.ts";
import { SECRET_PATTERNS } from "../src/secret-patterns.ts";
import { leaksKey, makeAssert } from "./lib/decision-fixtures.ts";
import { PEM_SEPARATORS } from "./lib/redaction-context-cases.ts";
import { PEM_AFTER_KEY } from "./lib/redaction-context-cases.ts";
import { PEM_PROSE_END } from "./lib/redaction-context-cases.ts";
import { PEM_LONG_CLIPPED } from "./lib/redaction-context-cases.ts";

const { assert, state } = makeAssert();

// ---- the arm's SEPARATOR: a key whose lines do not end in "\r?\n" still redacts whole.
//
// The arm carried `\r?\n` as its only line separator, so for each shape below the match
// stopped at the header and `redactSecrets` reported `redactions: 1` while both base64
// lines shipped — a count that reads like success over a document carrying the whole key.
// That is why every case asserts through `leaksKey` on BOTH body lines and through BOTH
// passes: `redactSecrets` proves the pattern, `redactBounded` proves the same pattern is
// still reachable from inside a scan window.

for (const { name, text, bodies } of PEM_SEPARATORS) {
  const passes: [string, { text: string; count: number }][] = [
    ["unbounded", redactSecrets(text)],
    ['bounded from="start"', redactBounded(text, 4000, "start")],
  ];
  for (const [where, r] of passes) {
    assert(r.count >= 1, `${name} (${where}): the arm matches the key at all (${r.count})`);
    for (const body of bodies) {
      assert(
        !leaksKey(r.text, body),
        `${name} (${where}): a 12-char window of the body line ${body.slice(0, 16)}… survives`,
      );
    }
  }
}

// ---- what follows the key: the arm must not eat the context a prefix rule needs.
//
// `armOnlyMustNotContain` runs the OTHER rules and then asserts on the PEM ARM's span, with the
// credential behind the key still in place. Through the full redactor the later rules catch these
// credentials even when the arm has amputated their context, so the whole-set assertion alone
// passes on the buggy ordering — verified by splicing HEAD's arm and ordering back in, which
// leaks the bearer probe through this pass while the full-set assertion for the same text stays
// green.

for (const { name, text, mustNotContain, armOnlyMustNotContain } of PEM_AFTER_KEY) {
  const r = redactSecrets(text);
  assert(
    r.count >= 2,
    `${name}: both the key and the credential behind it are redacted (${r.count})`,
  );
  for (const leak of mustNotContain) {
    assert(
      !r.text.includes(leak),
      `${name}: ${JSON.stringify(leak)} survives after a clipped key (${JSON.stringify(r.text.slice(0, 120))})`,
    );
  }
  if (!armOnlyMustNotContain) continue;
  // Rules BEFORE the PEM arm first, so the only thing that can strand the credential is the arm.
  const armOnly = SECRET_PATTERNS.filter((re) => !re.source.includes("BEGIN")).reduce(
    (acc, re) => acc.replace(new RegExp(re.source, "g"), REDACTED),
    text,
  );
  for (const leak of armOnlyMustNotContain) {
    assert(
      !armOnly.includes(leak),
      `${name} (arm alone): the arm ate the ${JSON.stringify(leak)}'s context and the prefix rule behind it can no longer match (${JSON.stringify(armOnly.slice(-70))})`,
    );
  }
}

// ---- an END delimiter quoted in PROSE is not a key, and the prose is not its body.

for (const { name, text, mustContain } of PEM_PROSE_END) {
  const r = redactSecrets(text);
  assert(
    r.count === 0 && r.text === text,
    `${name}: nothing is redacted and the sentence survives (${r.count}, ${JSON.stringify(r.text)})`,
  );
  assert(
    r.text.includes(mustContain),
    `${name}: ${JSON.stringify(mustContain)} is preserved (${JSON.stringify(r.text)})`,
  );
}

// ---- a key longer than the window: the scan must reach back to the header it cut off.

for (const { name, text, body, max } of PEM_LONG_CLIPPED) {
  const r = redactBounded(text, max, "end");
  assert(
    r.count >= 1,
    `${name} (from="end", max ${max}): the scan reaches the header behind the cut (${r.count})`,
  );
  assert(
    !leaksKey(r.text, body),
    `${name} (from="end", max ${max}): the visible body of the long key ships (${JSON.stringify(r.text.slice(0, 60))})`,
  );
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
