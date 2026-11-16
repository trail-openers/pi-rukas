/**
 * work-driver-verify-develop-provenance-limits — the two read ceilings the data-provenance gate
 * imposes on its git reads, split out so both the gate module and its commit-read module can
 * name one number without importing each other.
 *
 * Each ceiling exists to make an over-large input a *disclosure* rather than a hang or a truncated
 * walk that still reported a verdict, so it is a value the disclosure text and the executor buffer
 * both read: one number, so a message claiming a 1 MiB ceiling cannot disagree with a buffer that
 * allowed more.
 */

/** The wall clock on the gate's own git reads (the OID pin, the added-file range, and every
 * probe). Shared so the timeout in a read and the message about it never drift. */
export const PROVENANCE_GIT_TIMEOUT_MS = 30_000;

/** Byte ceiling on one added data file. Past it the file is disclosed, never judged. It is
 * also the ceiling that the read's own executor buffer is set from, plus headroom: the bound is
 * what makes an over-large record a disclosure rather than a hang, and there is one number so
 * the two cannot disagree about what the gate is willing to read. */
export const PROVENANCE_FILE_MAX_BYTES = 1024 * 1024;

/** The leading clause every provenance failure and every "could not tell" note carries, so the
 * gate's own rows are findable in a failure list and no cap router can mistake one for a verify
 * verdict. One constant for both channels: a reader grepping `data provenance:` wants every row
 * this gate wrote, and the row's own words say which channel it is. Lives here because the modules
 * that write those rows — the gate and the disclosure renderer — both read this file, and neither
 * may import the other. */
export const PROVENANCE_FAILURE_PREFIX = "data provenance:";

/** The leading clause of the gate's "could not tell" notes — the same prefix as a failure, because
 * the channel is told by the row's words and not by its prefix. */
export const PROVENANCE_NOTE_PREFIX = PROVENANCE_FAILURE_PREFIX;
