/**
 * work-driver-merged-gate-files — the merge-time gate for paths a repository
 * declares as gate files in its own doctrine. The built-in protected set is one
 * project's list; a repository that names its build manifest or a safety script a
 * gate file has another, and its doctrine is the only source for it.
 *
 * Doctrine is read at the cycle's base commit, so a sentence a subagent wrote during
 * this cycle declares nothing. One judged question on the existing policy seam reads
 * the list; no path is lifted out of the prose by a regex. An entry is honoured only
 * when its own quote is found verbatim (modulo formatting) in a document this read
 * was given AND that quote names the entry's path.
 *
 * No document mentions gate files (the normal case): no question is asked, the merge
 * proceeds. A mention with nothing verifiable behind it parks, and so does a judge
 * that could not answer — while the documents speak of gate files, an absent answer
 * is not a declaration of none.
 *
 * A declared entry ending in `/` is a directory prefix, anything else an exact path;
 * the compared set is the PR's own commits over the merge-base range, both sides of
 * every rename. Like the protected gate this sits outside the merge-authority switch:
 * neither `--merge` nor a doctrine grant reaches it, and the PR is left open.
 */

import { citationPresent, normaliseForCitation } from "./decision-evidence.ts";
import { type ProtectedMergeRead, mergeDeclaredGateFileChanges } from "./merge-protected-paths.ts";
import { protectedPathsSentence } from "./protected-paths-text.ts";
import { trace } from "./trace.ts";
import { protectedPathKey } from "./work-driver-doctrine.ts";
import { mergeProtectedHold } from "./work-driver-merged-hold.ts";
import {
  type DoctrineDoc,
  type PolicyDecision,
  type PolicyJudgeFn,
  askPolicy,
} from "./work-driver-policy.ts";
import type { ProtectedPathExec } from "./work-driver-protected-paths-read.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";

/** Case-insensitive: the phrase is prose, in whatever language the operator wrote. */
const GATE_FILE_MENTION = /gate\s+files?/i;

/** The one question the declared list is read with. */
const GATE_FILES_QUESTION =
  "Which paths do these documents declare as gate files — files or directories that a human must merge rather than an automated agent? For each declared path, report an entry: `path` exactly as the document spells it, and `quote` — the one sentence that names that path, copied word for word. Report no path your quote does not itself contain.";

/** The judge's tool call carries the list; nothing here interprets it. */
type GateFileCall = { verdict: string; entries?: readonly unknown[] };

type DeclaredGateFile = { path: string; quote: string };

/**
 * The claims this read may honour: an entry counts only when its own quote is found
 * in a document the caller read at the base commit AND it names the entry's path.
 */
function verifiedEntries(
  entries: readonly unknown[] | undefined,
  texts: readonly string[],
): DeclaredGateFile[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((e): e is DeclaredGateFile => {
    const entry = e as DeclaredGateFile;
    return (
      !!entry &&
      typeof entry.path === "string" &&
      entry.path.length > 0 &&
      typeof entry.quote === "string" &&
      texts.some((t) => citationPresent(entry.quote, t)) &&
      normaliseForCitation(entry.quote).includes(normaliseForCitation(entry.path))
    );
  });
}

/**
 * A directory declaration keeps its trailing `/`: it is the ONLY thing that tells
 * this apart from an exact path, and `protectedPathKey` would strip it. Nothing else
 * may compare on the raw string — an absolute or `./`-prefixed declaration still has
 * to name the same path the diff printed.
 */
function declaredKey(pathValue: string): string | undefined {
  const key = protectedPathKey(pathValue);
  if (!key) return undefined;
  return pathValue.endsWith("/") || pathValue.endsWith("\\") ? `${key}/` : key;
}

/** Does this declared entry cover this changed path? A trailing `/` is a prefix. */
function entryCovers(entry: DeclaredGateFile, path: string): boolean {
  const declared = declaredKey(entry.path);
  const changed = protectedPathKey(path);
  if (!declared || !changed) return false;
  return declared.endsWith("/") ? changed.startsWith(declared) : changed === declared;
}

/** The park every refusal here writes: the same hold shape the protected gate uses. */
function park(state: WorkState, reason: string): WorkState {
  trace(`work-driver: merge held — ${reason.slice(0, 200)}`);
  return appendEvent(mergeProtectedHold(state, reason), {
    kind: "cap-hit",
    at: Date.now(),
    cap: "awaiting-human-merge",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
  });
}

/**
 * The merge-time gate for the paths this repository declares as gate files:
 * `undefined` when the merge may go ahead — nothing mentions gate files, or the
 * verified list touches nothing the PR changed — or the next state `runMerged`
 * returns. `docs` are the documents the authority judge was handed, read at the base
 * commit; `judge` is the caller's judge, so this never decides who may answer.
 */
export async function heldForDeclaredGateFiles(
  repoRoot: string,
  state: WorkState,
  exec: ProtectedPathExec,
  judge: PolicyJudgeFn,
  docs: readonly DoctrineDoc[],
  where: { repoRoot?: string; issues?: readonly number[] },
  headOid?: string,
): Promise<WorkState | undefined> {
  const declaring = docs.filter((d) => GATE_FILE_MENTION.test(d.text));
  if (declaring.length === 0) return undefined;
  const who = declaring.map((d) => d.file).join(", ");
  const claims: GateFileCall[] = [];
  const listJudge: PolicyJudgeFn = async (prompt, signal) => {
    const answer = await judge(prompt, signal);
    for (const use of answer?.toolUses ?? []) {
      const call = (use as { arguments?: GateFileCall })?.arguments;
      if (call && typeof call.verdict === "string") claims.push(call);
    }
    return answer;
  };
  const decision: PolicyDecision = await askPolicy(listJudge, GATE_FILES_QUESTION, docs, where);
  const entries = verifiedEntries(
    decision.quoteVerified ? claims.flatMap((c) => c.entries ?? []) : undefined,
    declaring.map((d) => d.text),
  );
  if (entries.length === 0) {
    return park(
      state,
      `${who} mention gate files, but no declared path could be verified against them (${decision.reason ?? "no judge answer"}), so the merge cannot be established as clearing them`,
    );
  }
  const changes: ProtectedMergeRead = await mergeDeclaredGateFileChanges(
    exec,
    repoRoot,
    state.pipelineState.branchName ?? "",
    headOid,
  );
  if (!changes.ok) {
    return park(
      state,
      `the declared gate-file list is in force, but the PR's change set could not be read (${changes.unreadable}) — a diff that could not be inspected is not a diff that clears it`,
    );
  }
  const hits = [
    ...new Set(changes.paths.filter((p) => entries.some((e) => entryCovers(e, p)))),
  ].sort();
  if (hits.length === 0) return undefined;
  return park(state, `${protectedPathsSentence(hits)} — declared as gate files by ${who}`);
}
