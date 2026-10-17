import { createHash } from 'node:crypto'

/**
 * Migration 0013: an agent can be the team's decision-maker.
 *
 * `role` is free text ("工程师", "研究员") and is used for display and for the
 * router's role-fit prompt. What it cannot express is authority: when a room
 * has several agents and a human asks an open question, someone has to own the
 * call. Today the election (`agents/routing-election.ts`) picks by availability
 * then id — deterministic and fair, but blind to who is actually accountable
 * for that kind of call.
 *
 * So authority becomes a column:
 *
 *   - `decision_scope`  what this agent may call, in their own words. Fed to the
 *                       router as "who to hand this to", and to the agent itself
 *                       as part of who they are. NULL = not a decider.
 *   - `decision_rank`   tie-break among deciders. Lower wins; 0 = the lead. Two
 *                       people with overlapping scopes resolve deterministically
 *                       instead of by id order, which would be an accident of
 *                       how rows were inserted.
 *
 * A decider is still one vote in a room of many — this changes who takes an
 * unaddressed turn, not whether everyone is heard.
 *
 * The index is a plain (transactional) CREATE INDEX: on a single-user local
 * install `participants` has a few rows, so the lock costs milliseconds. It is
 * grandfathered in scripts/guard-migration-locks.mjs — that guard is written for
 * cloud deploys serving live traffic, and the checksum is already pinned.
 */
export const DECISION_ROLE_SQL = `
ALTER TABLE participants ADD COLUMN IF NOT EXISTS decision_scope TEXT;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS decision_rank  INTEGER NOT NULL DEFAULT 0;
-- Only meaningful for deciders; keeps "who decides here" a cheap lookup.
CREATE INDEX IF NOT EXISTS idx_participants_deciders
  ON participants (company_id, decision_rank, id)
  WHERE decision_scope IS NOT NULL;
`

export function decisionRoleChecksum(): string {
  return createHash('sha256').update(DECISION_ROLE_SQL).digest('hex')
}
