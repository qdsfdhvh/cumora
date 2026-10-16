/** Pure storage-reference policy shared by API persistence and agent reads.
 *
 * A message attachment URL is presentation data: signatures expire and the
 * client can alter it. Only a server-generated `attachments/` key may choose
 * what the server reads. Keeping this module free of env/storage imports makes
 * the trust boundary directly unit-testable. */

const STORAGE_KEY_PREFIXES = ['attachments/', 'email-attachments/', 'avatars/']

function stripQueryAndHash(value: string): string {
  return value.split('?')[0].split('#')[0]
}

export function normalizeStorageKey(raw: string): string | null {
  try {
    const key = decodeURIComponent(stripQueryAndHash(raw.trim()).replace(/^\/+/, ''))
    if (!key || key.length > 1024) return null
    if (/[\\\u0000-\u001f\u007f]/.test(key) || key.includes('?') || key.includes('#')) return null
    const segments = key.split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
    const prefix = STORAGE_KEY_PREFIXES.find((candidate) => key.startsWith(candidate))
    if (!prefix || key.length === prefix.length) return null
    return key
  } catch {
    return null
  }
}

/** Derive a storage key only from a local upload URL or the configured R2
 * public origin. Arbitrary absolute URLs are never storage references. */
export function storageKeyFromPublicUrl(raw: string, r2PublicBase: string, uploadsBase = ''): string | null {
  const value = raw.trim()
  if (!value) return null

  if (value.startsWith('/uploads/')) {
    return normalizeStorageKey(value.slice('/uploads/'.length))
  }

  // Absolute local-storage URL (`http://127.0.0.1:<port>/uploads/<key>`) when
  // the desktop app configured CUMORA_UPLOADS_BASE, as well as the relative
  // form above.
  if (uploadsBase) {
    try {
      const url = new URL(value)
      const base = new URL(uploadsBase)
      if (url.origin === base.origin && url.pathname.startsWith('/uploads/')) {
        return normalizeStorageKey(url.pathname.slice('/uploads/'.length))
      }
    } catch {
      // fall through to the R2 rules below
    }
  }

  if (!r2PublicBase) return null
  try {
    const url = new URL(value)
    const base = new URL(r2PublicBase)
    const basePath = base.pathname.replace(/\/+$/, '')
    if (url.origin !== base.origin) return null
    if (basePath && !url.pathname.startsWith(`${basePath}/`)) return null
    const rawKey = basePath
      ? url.pathname.slice(basePath.length + 1)
      : url.pathname.replace(/^\/+/, '')
    return normalizeStorageKey(rawKey)
  } catch {
    return null
  }
}

/**
 * The `avatars/…` key a value refers to, when it refers to one.
 *
 * Avatar columns accept both shapes the app produces — the key itself and a
 * read URL — so every consumer needs the same key resolution before it can
 * decide how to serve the value.
 */
export function avatarStorageKey(raw: string, r2PublicBase: string, uploadsBase = ''): string | null {
  const value = raw.trim()
  if (!value) return null
  const direct = normalizeStorageKey(value)
  if (direct?.startsWith('avatars/')) return direct
  const mapped = storageKeyFromPublicUrl(value, r2PublicBase, uploadsBase)
  return mapped?.startsWith('avatars/') ? mapped : null
}

/**
 * Is this value a reference to a stored avatar (rather than arbitrary text)?
 *
 * Avatar columns are rendered straight into <img src>, so a typo or a foreign
 * host should never reach them. Accepts the three shapes the app produces:
 * an `avatars/…` key, a `/uploads/avatars/…` path, or an absolute URL that maps
 * back to one of the configured storage bases.
 */
export function isStoredAvatarReference(raw: string, r2PublicBase: string, uploadsBase = ''): boolean {
  const value = raw.trim()
  if (!value) return false
  if (avatarStorageKey(value, r2PublicBase, uploadsBase)) return true
  if (value.startsWith('/uploads/avatars/')) return normalizeStorageKey(value.slice('/uploads/'.length)) !== null
  // An absolute /uploads/avatars/… URL we cannot map to a key is still a
  // storage reference (e.g. the port changed since it was written).
  try {
    return new URL(value).pathname.startsWith('/uploads/avatars/')
  } catch {
    return false
  }
}

/** Select the authoritative object key for a chat message attachment.
 *
 * A valid explicit key wins even when its accompanying URL is a presigned S3
 * URL that cannot be derived from R2_PUBLIC_BASE; consumers must regenerate
 * the URL from that key. If both fields identify known storage objects they
 * must agree, preventing a confused-reference mismatch. */
export function messageAttachmentStorageKey(
  input: { key?: unknown; url?: unknown },
  r2PublicBase: string,
  uploadsBase = '',
): string | null {
  const rawKey = typeof input.key === 'string' ? input.key.trim() : ''
  const fromUrl = typeof input.url === 'string'
    ? storageKeyFromPublicUrl(input.url, r2PublicBase, uploadsBase)
    : null

  if (rawKey) {
    const fromKey = normalizeStorageKey(rawKey)
    if (!fromKey?.startsWith('attachments/')) return null
    if (fromUrl && fromUrl !== fromKey) return null
    return fromKey
  }

  return fromUrl?.startsWith('attachments/') ? fromUrl : null
}
