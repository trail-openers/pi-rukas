/**
 * ledger-migrate — retained for import compatibility: the in-file
 * decision-ledger body removal now lives in section-detect.ts
 * (`removeInFileLedgerBody`), the one shared migration module (M2, #681).
 */
export { removeInFileLedgerBody } from "./section-detect.ts";
