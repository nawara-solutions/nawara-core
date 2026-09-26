/**
 * Stage 20.6: process-local counters for the automation and owner-administration surfaces (the Audit / File operational-snapshot pattern;
 * the compatibility read has its own, Stage 20.5). Every label is from a CLOSED set: an operation and an outcome. Never a product,
 * component, version, release, caller, owner, Company, session, proof, address or correlation id.
 */
export const AUTOMATION_OPERATIONS = ['register', 'publish'] as const;
export const AUTOMATION_OUTCOMES = ['changed', 'unchanged', 'denied', 'invalid', 'not_found', 'conflict', 'failed'] as const;
export const ADMIN_OPERATIONS = ['withdraw', 'policy_change'] as const;
export const ADMIN_OUTCOMES = [
  'changed', 'unchanged', 'unauthenticated', 'authority_denied', 'step_up_denied', 'invalid', 'not_found', 'conflict', 'auth_timeout', 'auth_unavailable', 'failed',
] as const;
export type AutomationOperation = (typeof AUTOMATION_OPERATIONS)[number];
export type AutomationOutcome = (typeof AUTOMATION_OUTCOMES)[number];
export type AdminOperation = (typeof ADMIN_OPERATIONS)[number];
export type AdminOutcome = (typeof ADMIN_OUTCOMES)[number];

/** A fixed grid of counters: its size is |operations| × |outcomes| whatever the traffic (no label can grow it). */
class Grid<O extends string, R extends string> {
  private cells: Map<string, number>;
  constructor(private readonly ops: readonly O[], private readonly outcomes: readonly R[]) {
    this.cells = this.empty();
  }
  private empty() {
    return new Map(this.ops.flatMap((o) => this.outcomes.map((r) => [`${o}_${r}`, 0] as const)));
  }
  count(op: O, outcome: R): void {
    const k = `${op}_${outcome}`;
    if (!this.cells.has(k)) return; // never a new label
    this.cells.set(k, this.cells.get(k)! + 1);
  }
  /** Every cell in a fixed order (zeros included), then reset. */
  drain(): Array<[string, number]> {
    const out = [...this.cells.entries()];
    this.cells = this.empty();
    return out;
  }
}

export class ReleaseCounters {
  readonly automation = new Grid<AutomationOperation, AutomationOutcome>(AUTOMATION_OPERATIONS, AUTOMATION_OUTCOMES);
  readonly admin = new Grid<AdminOperation, AdminOutcome>(ADMIN_OPERATIONS, ADMIN_OUTCOMES);
}
