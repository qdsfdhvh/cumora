/**
 * Avatar upload parsing — shared by the two places a portrait can be replaced
 * with an uploaded image: the owner's own profile (`POST /me/avatar`) and an
 * agent's (`POST /agents/:id/avatar`).
 *
 * Pure (no storage, no database) so the rules are unit-testable: only raster
 * image MIME types, only real base64, and a hard size ceiling. The cloud build
 * never needed this — portraits came from the OAuth provider or an image
 * model — but the local build lets you drop in any picture you like.
 */
export interface AvatarUpload {
  buf: Buffer
  mime: string
  /** File extension for the storage key. */
  ext: string
}

/** Raster formats the `/uploads` static handler serves inline. Deliberately
 *  excludes SVG: it is active content, and it would be served from the app
 *  origin in local-storage mode. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export class AvatarUploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'AvatarUploadError'
  }
}

export function normalizeAvatarUpload(body: unknown, maxBytes: number): AvatarUpload {
  const input = (body ?? {}) as { mime?: unknown; dataBase64?: unknown }
  const mime = String(input.mime ?? '').trim().toLowerCase()
  const dataBase64 = typeof input.dataBase64 === 'string' ? input.dataBase64 : ''

  if (!mime || !dataBase64) throw new AvatarUploadError('mime and dataBase64 are required', 400)
  const ext = IMAGE_EXTENSIONS[mime]
  if (!ext) throw new AvatarUploadError(`an image is required (got ${mime})`, 415)

  // Buffer.from ignores invalid characters, so reject anything that is not
  // plausible base64 before decoding rather than storing garbage.
  const compact = dataBase64.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new AvatarUploadError('dataBase64 is not valid base64', 400)
  }
  const buf = Buffer.from(compact, 'base64')
  if (buf.length === 0) throw new AvatarUploadError('the image is empty', 400)
  if (buf.length > maxBytes) {
    throw new AvatarUploadError(`the image is larger than ${Math.round(maxBytes / 1024 / 1024)}MB`, 413)
  }
  return { buf, mime, ext }
}
