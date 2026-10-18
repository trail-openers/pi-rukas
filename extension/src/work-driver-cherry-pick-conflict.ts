/**
 * work-driver-cherry-pick-conflict — #813: the shape of a conflicted
 * cherry-pick batch, split out of work-driver-cherry-pick.ts (AGENTS.md §12
 * file-size cap).
 *
 * `cherryPickWorkstreams` used to signal a conflict with the bare string
 * `"conflict"`. That said *that* the batch aborted and nothing about *which*
 * pick failed or what had already applied cleanly — so every caller upstream
 * filled the gap with the same guess: "two workstreams edited the same lines;
 * the decomposition is incoherent", and told the operator to re-split.
 *
 * Since #1005 merges genuinely coupled workstreams at plan time, that guess
 * is usually wrong for the pair that still collides: disjoint declared paths
 * that couple through TYPES (the #792 DeliverableStatus/ConvergeEvidence
 * shape) collide at consolidation with no fence violation anywhere, and
 * re-splitting the same split cannot converge. The fields below are what the
 * batch actually observed, so the reporters describe the observation and the
 * reader decides whether the workstreams are coupled.
 */

export interface CherryPickConflict {
  /**
   * The discriminator. A structural marker (not a bare string) so the type
   * carries the observation alongside it.
   */
  __conflict: true;
  /** The workstream whose pick failed (the batch aborts at the first). */
  conflictedAt: string;
  /** Workstreams whose picks applied cleanly before the aborting pick. */
  appliedBeforeConflict: string[];
  /**
   * The path `git cherry-pick` named for the aborted pick, when its output
   * carried one ("could not apply src/foo.ts" / "CONFLICT (content): Merge
   * conflict in src/foo.ts"), extracted by the batch's own `conflictedFileFrom`
   * rather than by a caller. Structured because the reporters must be able to
   * say WHICH file collided without scanning an arbitrary stderr blob for a
   * path — free prose deciding the diagnosis is the #813 defect again. Only
   * git's two conflict phrasings are read, and the tail must look like a path,
   * so a bare word in unrelated output yields `undefined`.
   */
  conflictedFile?: string;
}

/**
 * The batch's own extraction of git's named file — kept here, next to the
 * field it fills, so the batch calls it at the moment it reads the error and
 * no caller has to parse stderr itself.
 */
export function conflictedFileFrom(gitOutput: string): string | undefined {
  // git's three collision phrasings, each with its own cue: git prints the
  // colliding path explicitly, so the cue is "in <path>" / "<path>: " and not
  // "could not apply <abbrev>..." (which names the COMMIT, not the file).
  // Requiring a path-looking tail is what keeps a commit abbreviation out of
  // the field — an observation the batch did not make must not populate it.
  const cues: Array<RegExp> = [
    /Merge conflict in\s+(\S+)/i,
    /CONFLICT \([^)]*\):\s*(?:[^\n]*?:\s*)?([\w./-]+\.\w+)/,
    /could not apply\s+[^\n]*?([\w./-]+\.\w+)/i,
  ];
  for (const cue of cues) {
    const candidate = gitOutput.match(cue)?.[1]?.replace(/^"|"$/g, "");
    if (!candidate || candidate.length < 2) continue;
    // A path, not a bare word: git names file paths, so a candidate with no
    // extension and no separator is prose that happened to sit after the cue.
    if (!/\//.test(candidate) && !/\.[\w]+$/.test(candidate)) continue;
    return candidate;
  }
  return undefined;
}
