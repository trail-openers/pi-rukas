/*
 * lib/lean-republish-recording-exec — the recorder the republish rule asserts against.
 *
 * The rule's promise is that the refusal it left standing is the refusal that shipped:
 * same
 * argv, same env, same forge-call order as the step had before the exemption existed.
 * That is a claim about the CALLS, and `lib/lean-publish-fixture.ts` cannot answer it
 * — it records the rendered `--force-with-lease=` argument and the env each git child
 * got, not the argv of every call, and its forge fake counts calls without an order
 * that a case can compare. So this wraps the fixture's own executor and forge and
 * records the sequence verbatim.
 *
 * It is a SPY, not a stub: every git call is forwarded to the real executor, so
 * origin still decides which pushes landed and which shas `ls-remote` answers. Only
 * the `merge-base --is-ancestor` probe is intercepted — it is the one read this switch
 * adds, and a case has to be able to see whether the off arm made it at all.
 */

import type { NormalizedPullRequest } from "../../src/forge-types.ts";
import type { PublishDeps, PublishForge } from "../../src/lean/publish-deps.ts";
import type { VerifyExec } from "../../src/lean/verify-types.ts";

/** One executor call, as the step handed it to the seam. */
export interface RepublishCall {
  cmd: string;
  argv?: string[];
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  killGroup?: boolean;
}

/** One forge call, in order, with the argument that identifies it. */
export interface RepublishForgeCall {
  call: "prList" | "prView" | "prDraft" | "prCreate";
  detail: string;
}

export interface RepublishRecorder {
  /** Everything the step asked the executor, in call order. */
  execCalls: RepublishCall[];
  /** Everything the step asked the forge, in call order. */
  forgeCalls: RepublishForgeCall[];
  /** The step's `merge-base --is-ancestor` probes, argv included. */
  ancestryCalls(): RepublishCall[];
  /** The push, if the step got that far. */
  pushCall(): RepublishCall | undefined;
  /** Wrap the fixture's `deps.exec` so the recorder sees every git call. */
  wrapExec(deps: PublishDeps): PublishDeps["exec"];
  /** The forge to hand the step: the rows it answers with, recorded as it answers. */
  forge(prs: NormalizedPullRequest[]): PublishForge;
}

const has = (argv: string[] | undefined, want: string): boolean => argv?.includes(want) === true;

/** New recorder per case: one drive, one call log. */
export function republishRecorder(): RepublishRecorder {
  const execCalls: RepublishCall[] = [];
  const forgeCalls: RepublishForgeCall[] = [];
  return {
    execCalls,
    forgeCalls,
    ancestryCalls: () => execCalls.filter((c) => has(c.argv, "merge-base")),
    pushCall: () => execCalls.find((c) => has(c.argv, "push")),
    wrapExec: (deps) =>
      // The seam this wraps widens `VerifyExec`'s answer to `| undefined` (its own
      // `execOver` may decline a call); this wrapper turns that into an empty answer,
      // which is what the recorder must forward to keep `VerifyExec`'s signature.
      (async (cmd: string, opts?: Parameters<PublishDeps["exec"]>[1]) => {
        execCalls.push({
          cmd,
          argv: opts?.argv === undefined ? undefined : [...opts.argv],
          cwd: opts?.cwd,
          timeout: opts?.timeout,
          maxBuffer: opts?.maxBuffer,
          killGroup: (opts as { killGroup?: boolean } | undefined)?.killGroup,
        });
        // `execOver` stays in front: a case that stubs a push's porcelain still can.
        // The seam's contract is an answer, so a forwarding call that resolved to nothing
        // becomes an empty one rather than an `undefined` the caller cannot use.
        // `PublishDeps["exec"]`'s declared contract is an ANSWER; the executor this wraps
        // only widens it, so the fallback keeps the recorder assignable to the seam.
        const ran: { stdout: string; stderr?: string } | undefined = await deps.exec(cmd, opts);
        return ran ?? { stdout: "", stderr: "" };
      }) as unknown as VerifyExec,
    forge: (prs) => {
      const rows = prs.map((pr) => ({ ...pr }));
      const created: NormalizedPullRequest[] = [];
      const f: PublishForge = {
        prList: async (opts) => {
          forgeCalls.push({
            call: "prList",
            detail: `${opts?.state ?? "?"}/${opts?.sourceBranch ?? "?"}`,
          });
          return rows;
        },
        prView: async (n) => {
          forgeCalls.push({ call: "prView", detail: String(n) });
          const row = rows.find((pr) => pr.number === n) ?? created.find((pr) => pr.number === n);
          if (row === undefined) throw new Error(`forge: no PR #${n}`);
          return row;
        },
        prDraft: async (n) => {
          forgeCalls.push({ call: "prDraft", detail: String(n) });
        },
        prCreate: async (title, head) => {
          forgeCalls.push({ call: "prCreate", detail: head });
          const made: NormalizedPullRequest = {
            number: 77,
            title,
            body: "",
            state: "OPEN",
            url: "https://forge.example/pull/77",
            headRefName: head,
            baseRefName: "main",
            author: undefined,
            mergeable: null,
            mergeStateStatus: null,
            isDraft: false,
            labels: [],
            createdAt: undefined,
            updatedAt: undefined,
          };
          created.push(made);
          return made;
        },
      };
      return f;
    },
  };
}
