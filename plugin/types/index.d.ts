/** One rule firing on one turn. Appended, never rewritten: the ledger is the record. */
export type Finding = {
  /** The rule's id: G1..G5. */
  rule: string
  /** One line naming what was seen, already trimmed for display. */
  detail: string
  /** The turn it fired on, so repeats of one turn group together. */
  turnId: string
  /** Epoch ms, for ordering and for the age shown in the report. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'measure-first': { findings: Shaped<Finding[]> }
  }
}
