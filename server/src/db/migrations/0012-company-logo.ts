import { createHash } from 'node:crypto'

/**
 * Migration 0012: a workspace can carry its own logo.
 *
 * The cloud build showed Cumora's mark everywhere and the workspace was a
 * tenant in someone else's product. The local build is the owner's own app, so
 * the workspace gets a logo image (and a name they can edit) that the title bar
 * and workspace switcher render instead of the built-in mark.
 *
 * Stored like avatars: an `avatars/company-<id>-<rand>.<ext>` key in local
 * storage, so the value is an absolute /uploads URL the renderer can use as-is.
 */
export const COMPANY_LOGO_SQL = `
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
`

export function companyLogoChecksum(): string {
  return createHash('sha256').update(COMPANY_LOGO_SQL).digest('hex')
}
