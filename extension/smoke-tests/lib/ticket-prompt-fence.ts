/**
 * lib/ticket-prompt-fence — the fence probe the ticket-aware assertions read a
 * brief through.
 *
 * A brief carries the issue body inside a ```text region the prompt itself
 * opened, and the question an assertion has to answer is not "does the heading
 * appear" (it always does, that is the point of printing the issue) but "does it
 * open a section of the brief". Fence lines the PROMPT opened are the only ``` at
 * column zero — a fence inside the payload is neutralised to U+02CB by
 * `fenceText` — so a line-by-line scan between those delimiters is exact.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

/** True when `heading` appears in `s` only inside a ``` fenced region the prompt
 * itself opened and closed — never beginning a line outside one. False when the
 * heading never appears at all: an assertion that reads this must also assert the
 * payload arrived, or it goes green on a brief that printed no issue. */
export function insidePromptFence(s: string, heading: string): boolean {
  let open = false;
  let seenInside = false;
  for (const line of s.split("\n")) {
    if (/^```/.test(line)) {
      open = !open;
      continue;
    }
    if (line === heading) {
      if (!open) return false;
      seenInside = true;
    }
  }
  return seenInside;
}
