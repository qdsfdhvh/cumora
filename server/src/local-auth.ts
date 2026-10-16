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

/** Stable identity for the machine's local user. One user per database. The
 *  address is only a default: the owner can change it in Me → profile, so
 *  lookups key on the local IDENTITY (not the address) and fall back to the
 *  default address only when no local identity exists yet. */
const LOCAL_EMAIL = 'local@cumora.local'
const LOCAL_PROVIDER = 'local'

interface LocalUserRow {
  id: string
  email: string
  display_name: string
  company_id: string | null
}

const LOCAL_USER_SELECT = `
  SELECT u.id, u.email, u.display_name,
         (SELECT company_id FROM company_members WHERE user_id = u.id ORDER BY joined_at ASC LIMIT 1) AS company_id
    FROM users u`

/** The machine's local account, keyed on its local IDENTITY so an edited
 *  email address still resolves to the same user (falling back to the default
 *  address for databases written before the identity row existed). */
async function findLocalUser(): Promise<LocalUserRow | null> {
  const byIdentity = await pool.query<LocalUserRow>(
    `SELECT u.id, u.email, u.display_name,
            (SELECT company_id FROM company_members WHERE user_id = u.id ORDER BY joined_at ASC LIMIT 1) AS company_id
       FROM user_identities ui
       JOIN users u ON u.id = ui.user_id
      WHERE ui.provider = $1
      ORDER BY ui.created_at ASC
      LIMIT 1`,
    [LOCAL_PROVIDER],
  )
  if (byIdentity.rows[0]) return byIdentity.rows[0]
  const byEmail = await pool.query<LocalUserRow>(
    `${LOCAL_USER_SELECT} WHERE LOWER(u.email) = $1 LIMIT 1`,
    [LOCAL_EMAIL],
  )
  return byEmail.rows[0] ?? null
}

/** What the sign-in screen may show before anyone signs in: the machine's
 *  local account (if it exists) and its workspace branding. Safe on loopback —
 *  the server refuses non-loopback clients in embedded mode. */
export interface LocalAccountSummary {
  name: string
  email: string
  avatarUrl: string | null
  workspaceName: string
  workspaceLogoUrl: string | null
}

export async function getLocalAccountSummary(): Promise<LocalAccountSummary | null> {
  const { rows } = await pool.query<{
    display_name: string; email: string; avatar_url: string | null
    company_name: string | null; logo_url: string | null
  }>(
    `SELECT u.display_name, u.email, u.avatar_url,
            c.name AS company_name, c.logo_url
       FROM user_identities ui
       JOIN users u ON u.id = ui.user_id
       LEFT JOIN company_members cm ON cm.user_id = u.id
       LEFT JOIN companies c ON c.id = cm.company_id
      WHERE ui.provider = $1
      ORDER BY ui.created_at ASC, cm.joined_at ASC
      LIMIT 1`,
    [LOCAL_PROVIDER],
  )
  const row = rows[0]
  if (!row) return null
  return {
    name: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    workspaceName: row.company_name ?? '',
    workspaceLogoUrl: row.logo_url ?? null,
  }
}

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
  // Fast path: the machine's local account already exists.
  const existing = await findLocalUser()

  if (existing) {
    // Self-heal: a local user with no workspace (e.g. a half-finished first
    // run) gets their personal workspace bootstrapped on next sign-in.
    const companyId = existing.company_id ?? await createPersonalWorkspace({
      userId: existing.id,
      displayName: existing.display_name,
    })
    const { token, expiresAt } = await createSession(existing.id, { ip: opts.ip ?? undefined, ua: opts.userAgent ?? undefined })
    return {
      token, expiresAt,
      user: { id: existing.id, email: existing.email, displayName: existing.display_name },
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
