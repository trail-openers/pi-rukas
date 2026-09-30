/**
 * #915 — operatorSteer terminal-safety: every rendered line of an
 * operatorSteer event must satisfy visibleWidth ≤ width, even when the
 * label makes the prefix (`you → <label>: `) alone wider than width.
 *
 * Regression test for the bug where `rows[0] = \`${prefix}${rows[0]}\``
 * prepended a full-width prefix to a row already wrapped to `width`,
 * producing a first line of visibleWidth = prefix + width > width.
 */
import {
  appendOperatorSteer,
  getBuffer,
  startBuffer,
} from "../src/dispatch-deck-live.ts";
import { eventLines } from "../src/dispatch-deck-live-view-render.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`FAILED: ${msg}`);
  }
}

const fakeTheme = {
  muted: (t: string) => `\x1b[2m${t}\x1b[0m`,
  error: (t: string) => `\x1b[31m${t}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// The echo event: a 200-char label and a 300-char text, rendered at
// widths 40 and 80. Every rendered line must have visibleWidth ≤ width,
// and the full text must be present across the wrapped lines.
// ---------------------------------------------------------------------------

const LONG_LABEL = "L".repeat(200); // 200-char label
const TEXT_300 = "x".repeat(300); // 300-char text

startBuffer("svw");
appendOperatorSteer("svw", LONG_LABEL, TEXT_300);
const buf = getBuffer("svw");
const ev = buf.find((e) => e.kind === "operatorSteer");
assert(ev !== undefined, "operatorSteer event exists in buffer");

if (ev) {
  for (const width of [40, 80]) {
    const lines: string[] = eventLines(ev, width, false, fakeTheme);
    assert(lines.length > 0, `width ${width}: lines rendered`);

    // 1. Every line must satisfy visibleWidth ≤ width.
    for (let i = 0; i < lines.length; i++) {
      const w = visibleWidth(lines[i]);
      assert(
        w <= width,
        `width ${width}, line ${i}: visibleWidth ${w} ≤ ${width}`,
      );
    }

    // 2. The full text must be present across the wrapped lines.
    //    Strip ANSI codes (the theme wrapper adds \x1b[2m...\x1b[0m) and
    //    concatenate all lines.
    const plain = lines
      .join("")
      .replace(/\x1b\[\d+m/g, "") // strip ANSI
      .replace(/you → .*?: /, ""); // strip the prefix
    assert(
      plain.includes(TEXT_300),
      `width ${width}: full 300-char text present across wrapped lines`,
    );

    // 3. The label prefix must be present (first line starts with "you →").
    const firstPlain = lines[0].replace(/\x1b\[\d+m/g, "");
    assert(
      firstPlain.startsWith("you →"),
      `width ${width}: first line starts with "you →"`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Wrap cache discipline: rendering the SAME event object at width 40
//    then 80 must not collide. The cache key includes width, so different
//    widths produce different entries. Both widths must be ≤ their budgets.
// ---------------------------------------------------------------------------
{
  startBuffer("svw2");
  appendOperatorSteer("svw2", "cache-label", "cache-test-text");
  const ev2 = getBuffer("svw2").find((e) => e.kind === "operatorSteer");
  if (ev2) {
    const at40 = eventLines(ev2, 40, false, fakeTheme);
    const at80 = eventLines(ev2, 80, false, fakeTheme);
    const plain40 = at40.join("").replace(/\x1b\[\d+m/g, "");
    const plain80 = at80.join("").replace(/\x1b\[\d+m/g, "");
    assert(
      plain40.includes("cache-test-text"),
      "cache: width 40 render contains text",
    );
    assert(
      plain80.includes("cache-test-text"),
      "cache: width 80 render contains text",
    );
    for (const l of at40)
      assert(visibleWidth(l) <= 40, "cache: width-40 line ≤ 40");
    for (const l of at80)
      assert(visibleWidth(l) <= 80, "cache: width-80 line ≤ 80");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
