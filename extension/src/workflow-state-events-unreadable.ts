/**
 * workflow-state-events-unreadable — the #1634 producer-stated fields of a
 * `dispatch-failed` event, extracted from workflow-state-events.ts (AGENTS.md
 * §12 file-size limit).
 *
 * They live apart from the union they intersect into because they answer a
 * question the union's other members never ask: what does the DRIVER itself
 * know about a failure it produced without running a child? The adversarial
 * gate writes them when its own git read failed. The event is shaped like a
 * failed dispatch only so the event log stays complete — no child ran — and
 * without the stated cause the classifier would read git's stderr as provider
 * text and report an outage that never happened.
 */

import type { DispatchFailureCause } from "./types.ts";

export interface DispatchUnreadableFields {
  /**
   * A cause the PRODUCER states, rather than one the classifier infers from
   * text. Today only `environment:diff-unreadable`. Read BEFORE any text is
   * consulted, so provider-shaped words inside git's message cannot turn a host
   * fault into a `provider-severed` retry — which is what made an unreadable
   * diff buy the ladder a minutes-floor wait on an outage that did not exist.
   */
  structuredCause?: DispatchFailureCause;
  /**
   * For an unreadable-diff failure, the read that failed, verbatim
   * (`git diff <baseSha>..HEAD`, `git status --porcelain -z
   * --untracked-files=all`). The cause names the CLASS; this names the command
   * the operator has to make work, which a class cannot.
   */
  readFailed?: string;
}
