/**
 * Local single-user auth — the personal-build replacement for the cloud
 * OAuth flows (Google / GitHub / GitLab / Apple).
 *
 * This fork of Cumora runs entirely on the user's own machine (embedded
 * PGlite database, no cloud services), so there is nothing to federate
 * sign-in against. The desktop app calls `POST /api/auth/local` once at
 * startup; this module find-or-creates the machine's single local user,
 * gives them a personal workspace (same seeding shape the old OAuth
 * Path C used: companies row + participant + #all-hands), and mints a
 * normal session through the exact `createSession` machinery the OAuth
 * callbacks used. Everything downstream (sessions table, sliding TTL,
 * authMiddleware) is unchanged.
 */
import { randomUUID } from 'node:crypto'
import { pool } from './db/pool.js'
import { createSession, gravatarUrlForEmail } from './auth.js'
import { insertPersonalWorkspace } from './personal-workspace.js'
import { joinAllHands } from './onboardCompany.js'

/** Stable identity for the machine's local user. One user per database. */
const LOCAL_EMAIL = 'local@cumora.local'
const LOCAL_PROVIDER = 'local'

export interface LocalAuthResult {
  token: string
  expiresAt: Date
  user: { id: string; email: string; displayName: string }
  companyId: string | null
}

/** Find-or-create the local user + their personal workspace, then mint a
 *  session. `displayName` is only honored on FIRST creation — later calls
 *  return the existing user untouched. */
export async function signInLocal(opts: {
  displayName?: string | null
  ip?: string | null
  userAgent?: string | null
}): Promise<LocalAuthResult> {
  // Fast path: user already exists.
  const existing = await pool.query<{ id: string; email: string; display_name: string; company_id: string | null }>(
    `SELECT u.id, u.email, u.display_name,
            (SELECT company_id FROM company_members WHERE user_id = u.id ORDER BY joined_at ASC LIMIT 1) AS company_id
       FROM users u WHERE LOWER(u.email) = $1 LIMIT 1`,
    [LOCAL_EMAIL],
  )
  if (existing.rows[0]) {
    const u = existing.rows[0]
    // Self-heal: a local user with no workspace (e.g. a half-finished first
    // run) gets their personal workspace bootstrapped on next sign-in.
    const companyId = u.company_id ?? await createPersonalWorkspace({
      userId: u.id,
      displayName: u.display_name,
    })
    const { token, expiresAt } = await createSession(u.id, { ip: opts.ip ?? undefined, ua: opts.userAgent ?? undefined })
    return {
      token, expiresAt,
      user: { id: u.id, email: u.email, displayName: u.display_name },
      companyId,
    }
  }

  // First run: create user + personal workspace + human participant.
  const displayName = (opts.displayName ?? '').trim() || 'Local User'
  const userId = `u-${randomUUID().slice(0, 12)}`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO users (id, email, display_name, password_hash, email_verified_at, is_admin, tier)
         VALUES ($1, $2, $3, NULL, NOW(), TRUE, 'free')`,
      [userId, LOCAL_EMAIL, displayName],
    )
    await client.query(
      `INSERT INTO user_identities (provider, provider_id, user_id, email_lower)
         VALUES ($1, $2, $3, $4)`,
      [LOCAL_PROVIDER, LOCAL_EMAIL, userId, LOCAL_EMAIL],
    )
    const avatar = gravatarUrlForEmail(LOCAL_EMAIL)
    await client.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [avatar, userId])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  const companyId = await createPersonalWorkspace({ userId, displayName })

  const { token, expiresAt } = await createSession(userId, { ip: opts.ip ?? undefined, ua: opts.userAgent ?? undefined })
  return {
    token, expiresAt,
    user: { id: userId, email: LOCAL_EMAIL, displayName },
    companyId,
  }
}

/** Create (or fetch) the local user's personal workspace + human
 *  participant, then join #all-hands. Idempotent: returns the existing
 *  membership if one appeared concurrently. */
async function createPersonalWorkspace(args: { userId: string; displayName: string }): Promise<string | null> {
  const { userId, displayName } = args
  const companyId = `co-${randomUUID().slice(0, 10)}`
  const avatar = gravatarUrlForEmail(LOCAL_EMAIL)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await insertPersonalWorkspace(client, {
      companyId,
      name: `${displayName}'s workspace`,
      ownerUserId: userId,
      email: LOCAL_EMAIL,
    })
    await client.query(
      `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [companyId, userId],
    )
    await client.query(
      `INSERT INTO participants (id, kind, name, role, initial, avatar_bg, avatar_url, status, company_id)
         VALUES ($1, 'human', $2, NULL, $3, '#FF8870', $4, 'avail', $5)
         ON CONFLICT (id, company_id) DO NOTHING`,
      [userId, displayName, displayName.charAt(0).toUpperCase(), avatar, companyId],
    )
    await client.query(
      `UPDATE users SET avatar_url = $1 WHERE id = $2 AND (avatar_url IS NULL OR avatar_url = '')`,
      [avatar, userId],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  // Best-effort community ritual — never blocks first login.
  try { await joinAllHands({ companyId, participantId: userId }) } catch { /* starter convos are optional */ }
  return companyId
}
