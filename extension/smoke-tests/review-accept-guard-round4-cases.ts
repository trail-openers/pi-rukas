/**
 * #1764 fix round 4 — the MONOTONE floor. Base's clause (5) was command-wide and
 * program-agnostic; every per-segment narrowing this PR layered on it became an
 * under-refusal the reviews kept finding (prefix words, stale-literal rebinding). The
 * rows below were each run through the frozen base guard (`accept-guard-base/`) and
 * through the guard at this commit: every one was REFUSED at base and ALLOWED at the
 * round-3 head — the exact direction the monotone invariant forbids.
 *
 * THE INVARIANT the tables pin: base refuses ⇒ head refuses, unless the exemption
 * module (`review-accept-exempt.ts`) POSITIVELY understands every segment. The
 * exemption, never the refusal, is the thing that needs proof.
 */

import type { ScopeClause } from "../src/review-accept-scope.ts";

export interface Round4Case {
  readonly c: string;
  readonly why: string;
  readonly clause: ScopeClause;
}

const D = String.fromCharCode(36);
const NL = String.fromCharCode(10);

/**
 * Rule (a) — prefix words. A CHECKED_TOOLS word standing behind any word the guard does
 * not recognise is a failed exemption proof: `timeout`, `xargs`, `parallel`, `watch`,
 * `stdbuf` may consume, split or re-execute the operand before the tool ever sees it,
 * and the guard cannot say which. `env A=1` and `nice -n 1` are the neighbouring shapes:
 * `env`/`nice` ARE sanctioned prefixes, and there the operand test is what refuses.
 */
export const ROUND4_PREFIX: readonly Round4Case[] = [
  {
    c: `timeout 300 cat ${D}V`,
    why: "timeout swallows 300 and runs cat on a path nobody names",
    clause: "unreadable-word",
  },
  {
    c: `timeout 5 head -40 ${D}V`,
    why: "the same with an option-bearing read tool",
    clause: "unreadable-word",
  },
  {
    c: `timeout 300 grep secret ${D}V`,
    why: "a search tool's operand under a prefix word",
    clause: "unreadable-word",
  },
  {
    c: `stdbuf -o0 cat ${D}V`,
    why: "a sanctioned prefix is still not the program — the -o0 operand block makes the program unrecognised",
    clause: "unreadable-word",
  },
  {
    c: `xargs cat ${D}V`,
    why: "xargs turns ITS operands into cat's arguments",
    clause: "unreadable-word",
  },
  {
    c: `printf x | xargs cat ${D}V`,
    why: "the pipe is no help: the xargs segment is not understood",
    clause: "unreadable-word",
  },
  {
    c: `parallel cat ${D}V`,
    why: "parallel redistributes operands across jobs",
    clause: "unreadable-word",
  },
  {
    c: `watch -n 1 cat ${D}V`,
    why: "watch RE-EXECUTES the rest of the segment on a timer",
    clause: "unreadable-word",
  },
  {
    c: `env A=1 cat ${D}V`,
    why: "a sanctioned prefix, an unresolved operand — the operand test refuses it",
    clause: "unreadable-word",
  },
  {
    c: `nice -n 1 cat ${D}V`,
    why: "the -n value block leaves the program unrecognised behind nice",
    clause: "unreadable-word",
  },
];

/**
 * Rule (b) — assignment ambiguity. EVERY `NAME=` binding counts, including
 * expansion-valued ones: a name with more than one binding, or with any non-literal
 * binding, never resolves. `F=x; F=$V; cat $F` used to resolve to the STALE `x` because
 * the resolver only ever counted literal bindings.
 */
export const ROUND4_ASSIGNMENTS: readonly Round4Case[] = [
  {
    c: `F=x; F=${D}V; cat ${D}F`,
    why: "an expansion-valued rebinding makes F ambiguous, not literal",
    clause: "unreadable-word",
  },
  {
    c: `F=x; F=$(printf a); cat ${D}F`,
    why: "a command substitution binding counts too",
    clause: "unreadable-word",
  },
  {
    c: `F=x; F=${D}V; rg ${D}F`,
    why: "the same rebinding in the PATTERN position — prose means PROSE, a substituted pattern is an operand",
    clause: "unreadable-word",
  },
  {
    c: `F=x; F=${D}V; head -10 ${D}{F}`,
    why: "the same rebinding behind a content reader's file operand",
    clause: "unreadable-word",
  },
];

/** A shell EXECUTES its operand whatever the quotes say: `bash -c "cat $V"` reaches the
 * store through bytes the guard cannot read, once any word brings the command into
 * scope. (`sh -c 'cat $V'` alone names no store-capable program to the normalised view —
 * allowed at base too, and left as it is.) */
export const ROUND4_SHELLS: readonly Round4Case[] = [
  {
    c: `echo hi && bash -c "cat ${D}V"`,
    why: "a shell segment carrying an expansion is understood only when expansion-free",
    clause: "unreadable-word",
  },
  {
    c: `echo hi && eval "cat ${D}V"`,
    why: "the eval builtin executes the same bytes",
    clause: "unreadable-word",
  },
];

/** The neighbours that must NOT have moved: every one is fully understood, so the
 * exemption lifts the base refusal exactly as the #1764 harvest measured. */
export const ROUND4_STILL_ALLOWED: readonly { c: string; why: string }[] = [
  {
    c: "export PATH=/tmp/bats-core/bin:$PATH; timeout 900 bats tests/install-meshvpn.bats 2>&1 | tail -8",
    why: "the harvest's class-a shape: every segment understood, every positional literal",
  },
  {
    c: 'tofu fmt -check -recursive; echo "FMT_EXIT=$?"',
    why: "the PRINT class echoes its arguments, it does not open them",
  },
  {
    c: "cd extension && echo $PWD",
    why: "the row #1764 was filed for — print class, literal operands",
  },
  {
    c: "grep -n 'a$' src/x.ts",
    why: "a SINGLE-QUOTED pattern is prose; the file operand is literal",
  },
  // REMOVED in fix round 5: `f=notes.md; cat $f` was here because the exemption proof read
  // a text the guard itself had substituted. It is refused now, pinned in ROUND5_ACCEPTED_COSTS.
  {
    c: "awk 'NR>=1 && NR<=2 { print $1 }' notes.txt",
    why: "a pattern tool's single-quoted program is prose, its file operand is literal",
  },
  {
    c: `bash scripts/verify-loop.sh smoke-tests/test-x.ts && echo "rc=$?"`,
    why: "the offline gate's own shape: the bash segment is expansion-free, the echo is print class",
  },
  {
    c: `grep -oE '\\$\\{[a-z_]+\\}' cloud-init.tftpl | sort -u`,
    why: "the harvest's class-b shape: a single-quoted regex pattern, a literal file",
  },
  {
    c: `cat <<'PY' > notes.md${NL}price ${D}5${NL}PY`,
    why: "a quoted heredoc body is data; the redirect target is literal",
  },
  // REMOVED in fix round 5: `F=.git/notes.txt; cat > $F` was here on the same substituted
  // text — and a REDIRECTION target is the last word in the command to guess at. Refused
  // now, pinned in ROUND5_ACCEPTED_COSTS.
];
