/**
 * Scratch probe from the issue #2668 relocation pass: it checked that the outcome record carries NO
 * `preserved` key when no criterion was preserved, on both arms of the switch. Nothing imports it. The
 * driver's scratch cleanup can remove it; it is a valid module so the tree lexer can read it.
 */
export {};
