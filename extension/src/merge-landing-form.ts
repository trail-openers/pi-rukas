/**
 * merge-landing-form — #2125 Rescope 2 (S1): the pre-check the merge guard
 * asks a non-ops child, before any hold code is computed. S3: these roles
 * never land a PR and the guard catches mistakes, not adversaries — children
 * run as the operator's own user — so a raw-text landing scan is proportionate
 * for them; `ops` and the parent (role unset) keep the classifier unchanged.
 *
 * Token walks only, never a regex with overlapping alternations under `*`:
 * that form backtracked catastrophically. Matching is on RAW tokens —
 * quote-stripping would release prose naming a landing inside an argument
 * while holding a quoted landing. The tool word is REQUIRED in front of
 * `pr`/`mr`; dropping it freed 48 more field rows but released 92 that only
 * MENTION the pair, which R3's zero-release bar refuses.
 */
const KW = "merge"; // the landing verb; `accept` is glab's word for it
const REST = /(pulls|merge_requests)\/\d+\/merge\b/i;
// A substitution can carry a whole landing the scan cannot see.
const SUBST = /\$[({]|`/;
// A bare `$VAR` counts only beside the verb: `$` is ordinary in jq programs.
const BARE_VAR = /\$[A-Za-z_]\w*/;
// R2's runners EXECUTE their argument, so a landing hides in the quoted text
// the shell will run. That is the INLINE forms — `-e`/`-c` and the bare `sh`/
// `bash` script position — where the argument IS the program. `bun <file>`
// executes a file's CONTENTS, not its name, so a verb in the filename is not
// an executed landing and the row stays released. A whole COMMAND-WORD match
// (never a path character, so `test-merge-guard.ts` is not a runner) and only
// beside the verb, keeping `bun run build` released.
const RUNNER =
  /(?:^|[\s;|&(`'])(?:sh|bash|zsh|dash|ksh|python3?|node|bun|deno|ruby|perl|eval|xargs)(?:[\s;|&)'"/]|$)/;
const INLINE = /(?:^|\s)(?:-(?:e|c)|--command|--eval)(?:\s|$)/;
const HAS_KW = new RegExp(`(?:^|[^\w])${KW}(?:[^\w]|$)`, "i");
// The verb inside a quoted span: an argument the runner will execute.
const QUOTED_KW = new RegExp(`['"][^'"]*(?:^|[^\\w])${KW}(?:[^\\w]|$)`, "i");

/**
 * Is the verb present as DATA the shell will execute — inside a quoted
 * argument, or after an inline-script flag? A verb that appears only inside a
 * bare word (a test filename like `test-guard-role-scoped-merge-2125.ts`) is
 * not executed text: `bun <file>` runs the file's CONTENTS, so the name is not
 * a landing. That is what separates the field's most-held shape from R2's
 * `bash -c 'gh pr <kw> 1'`, which stays held.
 */
function verbIsData(line: string): boolean {
  if (INLINE.test(line) && HAS_KW.test(line)) return true;
  return QUOTED_KW.test(line);
}

/** S2's landing forms on one line; `api … pulls/N/<kw>` is the REST path. */
function landing(line: string): boolean {
  if (REST.test(line) || SUBST.test(line)) return true;
  const t = line.split(/\s+/).filter(Boolean);
  if (RUNNER.test(line) && verbIsData(line)) return true;
  const at = (w: string, from: number) => t.findIndex((x, i) => i >= from && x.toLowerCase() === w);
  if (at(KW, 0) >= 0 && BARE_VAR.test(line)) return true;
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!.toLowerCase();
    if (w === "gh" || w === "glab") {
      const kw = at(w === "gh" ? "pr" : "mr", i + 1);
      if (kw >= 0 && (at(KW, kw + 1) >= 0 || (w === "glab" && at("accept", kw + 1) >= 0)))
        return true;
    } else if (w === "git") {
      // `git <kw>`: only git's global options (and a -C/-c value) between.
      for (let j = i + 1; j < t.length; j++) {
        if (t[j]!.toLowerCase() === KW) return true;
        if (!t[j]!.startsWith("-")) break;
        if (t[j] === "-C" || t[j] === "-c") j++;
      }
    } else if (w === "hub" && at(KW, i + 1) >= 0) return true;
  }
  return false;
}

/**
 * `release` for a child that cannot land a PR; `hold` falls through to the
 * classifier. The role is read here, not passed in, so the guard's own source
 * stays free of `PI_ENSEMBLE_ROLE`: `test-merge-guard.ts` pins the guard
 * ROLE-AGNOSTIC, and this scoping is the deliberate exception, owned here.
 * Read per call, never cached — the parent and each child differ.
 */
export function roleScopedMergeVerdict(command: string): "release" | "hold" {
  const r = process.env.PI_ENSEMBLE_ROLE?.trim().toLowerCase() ?? "";
  if (r === "" || r === "ops") return "hold";
  // Anything not a plain string (`test-merge-guard-allowlist.ts` hands over a
  // non-string to drive the classifier-threw arm) is held: the pre-check may
  // only shorten a hold, so an unreadable value falls through to the reader,
  // which owns the fail-closed refusal.
  if (typeof command !== "string") return "hold";
  return command.split("\n").some(landing) ? "hold" : "release";
}
