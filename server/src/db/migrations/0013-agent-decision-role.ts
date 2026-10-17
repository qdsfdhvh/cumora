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
 * The index is built CONCURRENTLY (see `transactional: false` in migrate.ts):
 * `participants` is on the hot path of nearly every query, and a plain
 * CREATE INDEX holds a write lock for the whole build. The guard test in
 * server/src/__tests__/guard-migration-locks.test.ts enforces that.
 */
export const DECISION_ROLE_COLUMNS_SQL = `
ALTER TABLE participants ADD COLUMN IF NOT EXISTS decision_scope TEXT;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS decision_rank  INTEGER NOT NULL DEFAULT 0;
`

export const DECISION_ROLE_INDEX_NAME = 'idx_participants_deciders'

/** Only meaningful for deciders; keeps "who decides here" a cheap lookup. */
export const DECISION_ROLE_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${DECISION_ROLE_INDEX_NAME}
  ON participants (company_id, decision_rank, id)
  WHERE decision_scope IS NOT NULL;
`

export function decisionRoleChecksum(): string {
  return createHash('sha256')
    .update(DECISION_ROLE_COLUMNS_SQL + DECISION_ROLE_INDEX_SQL)
    .digest('hex')
}
