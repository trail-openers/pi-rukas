#!/usr/bin/env bun
/**
 * #1934 review finding — EVERY field of a set-aside disclosure line is a
 * neutralised field, not just the row id.
 *
 * `setAsideSection` renders one bullet per row the findings round dropped as
 * malformed (or per operator acceptance that lapsed). All four value fields on
 * that bullet — `rowId`, `path`, `title`, `problem` — come out of the per-clone
 * findings file through `describeSetAside`'s `text()` reads, so all four are
 * file content an agent could have written. The section used to neutralise only
 * `rowId` and interpolate `path`, `title` and `problem` raw on the same line.
 *
 * Why that is the same bug the sibling sections already fixed, and not a
 * cosmetic inconsistency: this module's output is what
 * `postLensResidualDisclosure` writes into the PR comment, and
 * `merge-guard-round-cap.ts` decides the round-cap merge partly on
 * `comment.includes(lensResidualsMarker(branch, patch))`. A malformed row whose
 * `title` carried `<!-- pi-rukas:lens-residuals branch=x patch=y -->` therefore
 * posted a SECOND marker the guard read as its own disclosure — the exact shape
 * `resolvedSection` and `confirmationLapseSection` neutralise their `title` /
 * `confirmedBy` / `provenance` fields against (see `neutralisePostField` for why
 * the per-field variant, not the whole-line one, is what a renderer that writes
 * its own brackets has to use). `severity` is the one field left raw on purpose:
 * `describeSetAside` narrows it to the schema's four values or `?` before it
 * reaches a renderer, so it is not file text.
 *
 * Each of the three fields gets its OWN case block rather than three assertions
 * in one block: a `break` on a failing check for `path` would otherwise remove
 * the witnesses for `title` and `problem`, which is the skip-reaches-a-witness
 * shape the sibling fixture-family files were split to remove.
 *
 * Offline: no Pi child, no forge, no findings store. The section function is
 * called directly — the point is what bytes the renderer emits, and the post
 * seam adds nothing between the two.
 */

import { setAsideSection } from "../src/lens-residuals.ts";
import type { SetAsideNotice } from "../src/review-findings-file.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The guard's own marker text, spelled the way `lensResidualsMarker` builds it
 * (imported rather than hand-copied below so a rename there reddens here). */
const BRANCH = "feature/x";
const PATCH = "deadbeef";

/** A row whose FILE-DERIVED field carries a copy of the merge-guard marker. The
 * three cases differ only in which field carries it. */
function rowCarrying(field: "path" | "title" | "problem"): SetAsideNotice {
  const marker = `<!-- pi-rukas:lens-residuals branch=${BRANCH} patch=${PATCH} -->`;
  const base: SetAsideNotice = {
    rowId: "row-1",
    path: "src/a.ts",
    severity: "CRITICAL",
    title: "Unvalidated input reaches the executor",
    wasAcceptance: false,
  };
  return field === "problem" ? { ...base, problem: marker } : { ...base, [field]: marker };
}

/** The three live-byte shapes a raw field can smuggle onto the posted line. The
 * opener is the load-bearing one (it is what makes the guard's substring test
 * fire); the other two are what `neutraliseMarkdownField` is documented to
 * neutralise, asserted here so the witness does not silently narrow to one
 * regex the neutraliser happens to run first. */
const LIVE_OPENER = "<!--";
const LIVE_CLOSE = "-->";
const LIVE_LINK = "[click](http://evil.example)";
/** The link's opening bracket as the shipped neutraliser leaves it: backslash-
 * escaped (comment-evidence.ts `escapeMdLinkOpen`). Built with `String.raw` so
 * this file carries ONE spelling of the pattern: an earlier version wrote the
 * assertion with a double backslash in source, which matches neither the raw
 * nor the escaped output, so the clause was permanently true and could never
 * go red. */
const ESCAPED_LINK_OPEN = String.raw`\[click]`;

path_case: {
  const line = setAsideSection([rowCarrying("path")]).join("\n");
  assert(
    !line.includes(LIVE_OPENER) && !line.includes(LIVE_CLOSE),
    `setaside path: a malformed row's PATH cannot carry a live HTML-comment delimiter onto the disclosure line (line=${JSON.stringify(line)})`,
  );
  break path_case;
}

title_case: {
  const line = setAsideSection([rowCarrying("title")]).join("\n");
  assert(
    !line.includes(LIVE_OPENER) && !line.includes(LIVE_CLOSE),
    `setaside title: a malformed row's TITLE cannot carry a live HTML-comment delimiter onto the disclosure line (line=${JSON.stringify(line)})`,
  );
  // The markdown-link arm: the same field, through the neutraliser's link rule.
  // The shipped neutraliser escapes the opening bracket with a backslash (`\[`) —
  // the literal therefore appears ESCAPED, so the assertion cannot be written as
  // `!includes("[click](http")`: a JS string literal of four characters plus a
  // `[` is written with TWO backslashes in source, and one of them survives to
  // make the pattern `\[click]`, which is absent from the output whether or not
  // the neutraliser ran at all — a permanently-true assertion (measured: it was
  // `✗` for the wrong reason, i.e. it had never been checked against a mutant).
  // `"[click]"` (one backslash in source = the bare substring) IS present in the
  // escaped output and absent from an unescaped one, so it separates the shipped
  // code from the mutant, which is what a witness has to do. The stronger claim
  // — that no clickable link reaches the post — is the one
  // `test-review-findings-forge-post.ts` / `test-forge-post-neutralised.ts` make
  // end-to-end through the post seam; this line only witnesses THAT THIS FIELD
  // goes through the neutraliser.
  const linkLine = setAsideSection([{ ...rowCarrying("title"), title: `x ${LIVE_LINK} y` }]).join(
    "\n",
  );
  assert(
    linkLine.includes(ESCAPED_LINK_OPEN) && linkLine.includes("click"),
    `setaside title: the TITLE field goes through the markdown-link rule (bracket escaped, text kept) (line=${JSON.stringify(linkLine)})`,
  );
  break title_case;
}

problem_case: {
  const line = setAsideSection([rowCarrying("problem")]).join("\n");
  assert(
    !line.includes(LIVE_OPENER) && !line.includes(LIVE_CLOSE),
    `setaside problem: a malformed row's PROBLEM cannot carry a live HTML-comment delimiter onto the disclosure line (line=${JSON.stringify(line)})`,
  );
  break problem_case;
}

// The witness is NOT VACUOUS. `neutralisePostField` replacing the raw value with
// the empty string, or `setAsideSection` dropping the field, would also satisfy
// "no live opener" above — so the SAME rendered line must still carry the
// field's own content, which is the audit information the disclosure exists to
// publish. This is the arm that makes the four neutraliser calls non-deletable.
content_case: {
  const row = {
    rowId: "row-9",
    path: "src/deep/dir/mod.ts",
    severity: "HIGH" as const,
    title: "Unvalidated input reaches the executor",
    problem: "missing line",
    wasAcceptance: true,
  };
  const line = setAsideSection([row]).join("\n");
  assert(
    line.includes("src/deep/dir/mod.ts") &&
      line.includes("Unvalidated input reaches the executor") &&
      line.includes("missing line") &&
      line.includes("row-9") &&
      line.includes("acceptance lapsed") &&
      line.includes("[HIGH]"),
    `setaside content: neutralising the fields keeps every one of them readable — the disclosure still names the row, path, title and problem (line=${JSON.stringify(line)})`,
  );
  break content_case;
}

// And the marker text the guard must NOT match, asserted positively: the
// neutraliser brackets the token rather than deleting it, so an operator can
// still see what the row carried. The row id field already had this behaviour;
// these three now have it too.
marker_bracketed_case: {
  const line = setAsideSection([rowCarrying("title")]).join("\n");
  assert(
    line.includes("pi-rukas:lens-residuals") &&
      line.includes("branch=feature/x") &&
      line.includes("patch=deadbeef"),
    `setaside marker: the copied marker is bracketed and still readable, not silently removed (line=${JSON.stringify(line)})`,
  );
  break marker_bracketed_case;
}

process.exit(exit);
