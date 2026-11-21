/**
 * lib/lean-verify-frozen — the one acceptance-test path a verify fixture freezes.
 *
 * Named once, here, because the fixture writes it, the baseline probe judges it, and the handback
 * logs name it in their `specify` row. Three readers, one literal: a case that changed the path in
 * one of the three would have its other two silently judge a file that is not there.
 */
export const FROZEN_FILE = "tests/AC1-retry.test.sh";
