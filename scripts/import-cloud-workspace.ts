/**
 * Import a Cumora **Cloud** workspace into this machine's local database.
 *
 * One-off migration helper for the personal build: reads a workspace from the
 * cloud API with your own session token, then writes participants,
 * conversations, and messages into the embedded (or dev) database, remapping
 * the cloud human to the local user and pulling avatars/attachments onto disk.
 *
 *   CUMORA_DATA_DIR="$HOME/Library/Application Support/Cumora/local" \
 *   CUMORA_CLOUD_TOKEN=<session token> \
 *   CUMORA_CLOUD_COMPANY=co-xxxxxxxx \
 *   CUMORA_CLOUD_EXPORT_DIR="$HOME/cumora-cloud-export-YYYYMMDD" \
 *   node --import tsx scripts/import-cloud-workspace.ts [--display-name Seiko]
 *
 * Actions are idempotent: conversations and messages already present (matched
 * by id) are left untouched, so re-running repairs a partial import.
 *
 * Requires network access to the cloud API — this is the ONLY step in the
 * personal build that talks to Cumora Cloud, and it is read-only.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const api = (process.env.CUMORA_CLOUD_API ?? 'https://api.cumora.ai/api').replace(/\/+$/, '')
const token = process.env.CUMORA_CLOUD_TOKEN ?? ''
const cloudCompany = process.env.CUMORA_CLOUD_COMPANY ?? ''
const dataDir = process.env.CUMORA_DATA_DIR ?? ''
const exportDir = process.env.CUMORA_CLOUD_EXPORT_DIR ?? ''
const displayName = (() => {
  const arg = process.argv.find((a) => a.startsWith('--display-name='))
  return arg ? arg.slice('--display-name='.length) : ('Seiko')
})()

if (!token || !cloudCompany) {
  console.error('CUMORA_CLOUD_TOKEN and CUMORA_CLOUD_COMPANY are required')
  process.exit(1)
}
if (!dataDir) {
  console.error('CUMORA_DATA_DIR is required (the local database directory)')
  process.exit(1)
}

const uploadsDir = process.env.CUMORA_UPLOAD_DIR || join(dataDir, 'uploads')
const uploadsBase = process.env.CUMORA_UPLOADS_BASE ?? ''

const { pool } = await import('../server/src/db/pool.js')
const { ensureSchema } = await import('../server/src/db/migrate.js')
const { signInLocal } = await import('../server/src/local-auth.js')

/* ---------------- helpers ---------------- */

async function columnsOf(table: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  )
  return new Set(rows.map((r) => r.column_name))
}

/** INSERT only the columns that exist in this database's schema. */
async function insertRow(table: string, row: Record<string, unknown>, cols: Set<string>, conflictOn: string): Promise<boolean> {
  const keys = Object.keys(row).filter((k) => cols.has(k) && row[k] !== undefined)
  if (keys.length === 0) return false
  const values = keys.map((k) => row[k])
  const params = keys.map((_, i) => `$${i + 1}`)
  const { rowCount } = await pool.query(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${params.join(', ')})
     ON CONFLICT (${conflictOn}) DO NOTHING`,
    values,
  )
  return (rowCount ?? 0) > 0
}

async function cloud<T>(path: string): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-company-id': cloudCompany },
  })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return await res.json() as T
}

/** Download a cloud asset into <uploads>/<key> and return the URL the local
 *  renderer should use (absolute when the app configured an uploads base). */
async function fetchAsset(key: string, url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const dest = join(uploadsDir, key)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buf)
    return uploadsBase ? `${uploadsBase}/uploads/${key}` : `/uploads/${key}`
  } catch {
    return null
  }
}

function absoluteOrNull(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null
  return url.startsWith('http') ? url : null
}

/* ---------------- main ---------------- */

await mkdir(dataDir, { recursive: true })
await mkdir(uploadsDir, { recursive: true })
await ensureSchema()
const local = await signInLocal({ displayName })
const localCompany = local.companyId
if (!localCompany) throw new Error('local sign-in produced no workspace')
console.log(`[import] local user ${local.user.id} · workspace ${localCompany}`)

const participants = await cloud<Array<Record<string, unknown>>>('/participants')
const conversations = await cloud<Array<Record<string, unknown>>>('/conversations')

const humanIds = new Set(participants.filter((p) => p.kind === 'human').map((p) => String(p.id)))
/** cloud human id → local user id (messages/author + membership arrays). */
function remapParticipant(id: unknown): string {
  const s = String(id)
  return humanIds.has(s) ? local.user.id : s
}

/* ---- participants: agents are created here; the local user already exists ---- */

const participantCols = await columnsOf('participants')
let agentsImported = 0
for (const p of participants) {
  if (p.kind !== 'agent') continue
  const id = String(p.id)
  const key = `avatars/${id}.jpg`
  const cloudAvatar = absoluteOrNull(p.avatarUrl)
  const localAvatar = cloudAvatar ? await fetchAsset(key, cloudAvatar) : null
  const inserted = await insertRow('participants', {
    id,
    kind: 'agent',
    name: p.name ?? id,
    role: p.role ?? null,
    initial: p.initial ?? String(p.name ?? id).charAt(0).toUpperCase(),
    avatar_bg: p.avatarBg ?? '#FF8870',
    avatar_url: localAvatar,
    status: 'resting',
    bio: p.bio ?? null,
    tools: p.tools ? JSON.stringify(p.tools) : null,
    system_prompt: p.systemPrompt ?? null,
    model: p.model ?? null,
    // Deliberately NOT carried over: computer_id / engine / provider_profile.
    // Agents land unassigned, and pairing a computer adopts them onto it.
    company_id: localCompany,
  }, participantCols, 'id, company_id')
  if (inserted) agentsImported++
  else {
    // Re-run: refresh the avatar if we now have one locally.
    if (localAvatar) {
      const { rows } = await pool.query<{ avatar_url: string | null }>(
        `SELECT avatar_url FROM participants WHERE id = $1 AND company_id = $2`, [id, localCompany],
      )
      if (rows[0] && !rows[0].avatar_url?.startsWith(uploadsBase || '/uploads/')) {
        await pool.query(`UPDATE participants SET avatar_url = $1 WHERE id = $2 AND company_id = $3`, [localAvatar, id, localCompany])
      }
    }
  }
}
console.log(`[import] agents: ${agentsImported} created, ${participants.filter((p) => p.kind === 'agent').length - agentsImported} already present`)

/* ---- the human's own avatar, so the roster matches the cloud ---- */
{
  const me = participants.find((p) => p.kind === 'human')
  const cloudAvatar = me ? absoluteOrNull(me.avatarUrl) : null
  if (cloudAvatar) {
    const localAvatar = await fetchAsset(`avatars/${local.user.id}.jpg`, cloudAvatar)
    if (localAvatar) {
      await pool.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [localAvatar, local.user.id])
      await pool.query(`UPDATE participants SET avatar_url = $1 WHERE id = $2 AND company_id = $3`, [localAvatar, local.user.id, localCompany])
    }
  }
}

/* ---- conversations ---- */

const convCols = await columnsOf('conversations')
const msgCols = await columnsOf('messages')
const counterCols = await columnsOf('conversation_counters')
let convsImported = 0
let messagesImported = 0

for (const c of conversations) {
  const id = String(c.id)
  const members = Array.isArray(c.members) ? (c.members as unknown[]).map(remapParticipant) : []
  const inserted = await insertRow('conversations', {
    id,
    kind: c.kind ?? 'group',
    title: c.title ?? id,
    subtitle: c.subtitle ?? null,
    members: JSON.stringify(members),
    pinned: Boolean(c.pinned),
    tag: c.tag ?? null,
    pulled_by: c.pulledBy ? JSON.stringify(c.pulledBy) : null,
    project_id: c.projectId ?? null,
    created_at: c.createdAt ?? new Date().toISOString(),
    updated_at: c.updatedAt ?? new Date().toISOString(),
    company_id: localCompany,
  }, convCols, 'id')
  if (inserted) convsImported++

  // Messages (exported to disk, or fetched now).
  let msgs: Array<Record<string, unknown>> | null = null
  if (exportDir) {
    const file = join(exportDir, 'messages.json')
    if (existsSync(file)) {
      const all = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8')) as Record<string, Array<Record<string, unknown>>>
      msgs = all[id] ?? null
    }
  }
  if (!msgs) {
    const page = await cloud<Array<Record<string, unknown>> | { messages: Array<Record<string, unknown>> }>(
      `/conversations/${id}/messages?limit=500`,
    )
    msgs = Array.isArray(page) ? page : page.messages
  }

  let maxSeq = 0
  for (const m of msgs) {
    const seq = Number(m.sequence) || 0
    if (seq > maxSeq) maxSeq = seq
    let attachment = m.attachment as Record<string, unknown> | null
    const attKey = attachment && typeof attachment.key === 'string' ? attachment.key : null
    const attUrl = attachment && typeof attachment.url === 'string' ? attachment.url : null
    if (attachment && attKey && attUrl) {
      const localUrl = await fetchAsset(attKey, attUrl)
      attachment = { ...attachment, ...(localUrl ? { url: localUrl } : {}) }
    }
    const ok = await insertRow('messages', {
      id: m.id,
      conversation_id: id,
      author_id: remapParticipant(m.authorId),
      kind: m.kind ?? 'text',
      body: m.body ?? '',
      sequence: seq,
      reactions: Array.isArray(m.reactions) && m.reactions.length ? JSON.stringify(m.reactions) : null,
      tool: m.tool ? JSON.stringify(m.tool) : null,
      attachment: attachment ? JSON.stringify(attachment) : null,
      client_id: m.clientId ?? null,
      quoted_message_id: m.quotedMessageId ?? null,
      created_at: m.createdAt ?? new Date().toISOString(),
      company_id: localCompany,
    }, msgCols, 'id')
    if (ok) messagesImported++
  }

  if (counterCols.size > 0) {
    await pool.query(
      `INSERT INTO conversation_counters (conversation_id, next_sequence) VALUES ($1, $2)
       ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = GREATEST(conversation_counters.next_sequence, $2)`,
      [id, maxSeq + 1],
    )
  }
  // Rebuild the denormalized membership projection the API reads from.
  await pool.query(`SELECT refresh_conversation_members_projection($1)`, [id]).catch(() => undefined)
}

/* ---- stop the pair-time onboarding from seeding a duplicate starter team ---- */

{
  const companyCols = await columnsOf('companies')
  const stamps: Record<string, unknown> = {}
  if (companyCols.has('starter_seeded_at')) stamps.starter_seeded_at = new Date().toISOString()
  if (companyCols.has('starter_dms_seeded_at')) stamps.starter_dms_seeded_at = new Date().toISOString()
  if (companyCols.has('all_hands_seeded_at')) stamps.all_hands_seeded_at = new Date().toISOString()
  const allHands = conversations.find((c) => ['Everyone', 'All hands', 'all-hands'].includes(String(c.title)))
  if (companyCols.has('all_hands_conversation_id')) stamps.all_hands_conversation_id = allHands ? String(allHands.id) : null
  if (Object.keys(stamps).length > 0) {
    const keys = Object.keys(stamps)
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
    await pool.query(`UPDATE companies SET ${sets} WHERE id = $${keys.length + 1}`, [...keys.map((k) => stamps[k]), localCompany])
  }
}

console.log(`[import] conversations: ${convsImported} created, ${conversations.length - convsImported} already present`)
console.log(`[import] messages: ${messagesImported} created`)
console.log('[import] done — start the app and it will show this workspace')
void resolve
