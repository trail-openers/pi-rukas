/**
 * public-hygiene-types — the shapes the public hygiene modules pass to each
 * other (#1788).
 *
 * `public-hygiene-scan.ts` produces them from a command string, the push
 * scanner produces them from git, and `public-hygiene-guard.ts` renders them
 * into a refusal. They live here because "a text the scan could not read is a
 * refusal" is one rule every module shares, and one rule needs one pair of
 * shapes — the reason `work-driver-context.ts` holds what the per-step driver
 * files share.
 */

/** One piece of text the command would publish. */
export interface PublishText {
  /** What the text is, for the refusal: "title", "body", "commit message", … */
  location: string;
  text: string;
  /** False for a code diff: the generic set does not apply there. */
  generic: boolean;
}

/** Something the command publishes that this module could not read. */
export interface ScanProblem {
  location: string;
  /** Why it could not be read. Never contains the file's content. */
  reason: string;
}

/** Everything one command contributes. */
export interface PublishScan {
  /** True when the command runs a forge publish verb at all. */
  publishes: boolean;
  texts: PublishText[];
  problems: ScanProblem[];
}

/** The outcome of the push scan: texts to check, or why it could not read. */
export interface PushScanResult {
  /** True when a github.com push was found and scanned. */
  scanned: boolean;
  texts: PublishText[];
  problems: ScanProblem[];
}
