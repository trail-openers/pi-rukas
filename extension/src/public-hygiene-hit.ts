/**
 * public-hygiene-hit — the FIRST dirty surface across the texts one publish
 * would put in front of the world (#1788 round 1), split out of
 * `public-hygiene-guard.ts` along the seam AGENTS.md §12 asks for.
 *
 * ## Why "first" and not "all"
 *
 * The refusal names one surface and one denylist line, and that is deliberate:
 * an agent rewriting a PR body works on what it is told, and a list of every
 * match would have to print each term to be useful — which is the one thing this
 * guard may never do. A second pass after the first is fixed costs one more tool
 * call and reveals the next hit; a refusal that named everything would name the
 * denylist itself.
 *
 * ## The three arms
 *
 * The hit mirrors `PublicTextHit` from `public-denylist.ts` and turns it into
 * what a refusal and a trace line need: WHERE (the location the scan assigned),
 * and either WHICH denylist line, WHICH generic category, or WHY the text could
 * not be read. `verdict` is the account `public-hygiene-verdict.ts` prints, so
 * the prose, the trace and the test all read the same fields rather than three
 * renderings that can drift apart.
 */

import { publicTextProblem } from "./public-denylist.ts";
import type { DenylistRead } from "./public-denylist.ts";
import type { DenylistHitLocation } from "./public-hygiene-refusals.ts";
import type { PublishText } from "./public-hygiene-types.ts";
import type { Verdict } from "./public-hygiene-verdict.ts";

/** What the first dirty surface was, in the form both renderers consume. */
export interface FirstHit {
  denylistHit?: DenylistHitLocation;
  genericHit?: { location: string; category: "private-ipv4" | "home-path" };
  verdict: Verdict;
}

/** The first dirty surface across every text this command would publish. */
export function firstHit(texts: readonly PublishText[], deny: DenylistRead): FirstHit | undefined {
  for (const text of texts) {
    const hit = publicTextProblem(text.text, deny, text.generic);
    if (!hit) continue;
    if (hit.kind === "unreadable") {
      return {
        verdict: { kind: "unreadable", location: text.location, length: text.text.length },
      };
    }
    if (hit.kind === "denylist") {
      return {
        denylistHit: { location: text.location, line: hit.line },
        verdict: {
          kind: "denylist",
          location: text.location,
          line: hit.line,
          length: text.text.length,
        },
      };
    }
    return {
      genericHit: { location: text.location, category: hit.category },
      verdict: {
        kind: "generic",
        location: text.location,
        category: hit.category,
        length: text.text.length,
      },
    };
  }
  return undefined;
}
