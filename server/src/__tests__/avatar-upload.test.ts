/**
 * Avatar upload validation — shared by the owner's own portrait and an
 * agent's. Local-only feature (no provider or image model involved), so these
 * rules are the whole gate between a form and object storage.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAvatarUpload, AvatarUploadError } from '../avatar-upload.js'

const MAX = 1024
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

test('decodes a raster image and reports its extension', () => {
  const up = normalizeAvatarUpload({ mime: 'image/png', dataBase64: png }, MAX)
  assert.equal(up.mime, 'image/png')
  assert.equal(up.ext, 'png')
  assert.equal(up.buf.length, 8)
  assert.deepEqual(normalizeAvatarUpload({ mime: 'image/jpeg', dataBase64: png }, MAX).ext, 'jpg')
})

test('rejects non-image and active-content types', () => {
  // SVG is deliberately out: it is active content, and in local-storage mode
  // uploads are served from the app origin.
  for (const mime of ['application/pdf', 'text/html', 'image/svg+xml', '']) {
    assert.throws(() => normalizeAvatarUpload({ mime, dataBase64: png }, MAX), AvatarUploadError, mime)
  }
})

test('normalises case and surrounding whitespace on the mime type', () => {
  assert.equal(normalizeAvatarUpload({ mime: ' IMAGE/PNG ', dataBase64: png }, MAX).ext, 'png')
})

test('rejects missing or malformed base64', () => {
  assert.throws(() => normalizeAvatarUpload({ mime: 'image/png' }, MAX), AvatarUploadError)
  assert.throws(() => normalizeAvatarUpload({ mime: 'image/png', dataBase64: 'not base64!!' }, MAX), AvatarUploadError)
  assert.throws(() => normalizeAvatarUpload({ mime: 'image/png', dataBase64: 'abc' }, MAX), AvatarUploadError)
})

test('rejects an image over the size ceiling before storing it', () => {
  const big = Buffer.alloc(MAX + 1, 1).toString('base64')
  assert.throws(() => normalizeAvatarUpload({ mime: 'image/png', dataBase64: big }, MAX), AvatarUploadError)
})

test('surface errors carry the HTTP status the route should return', () => {
  const statusFor = (body: unknown) => {
    try { normalizeAvatarUpload(body, MAX); return 200 }
    catch (e) { return e instanceof AvatarUploadError ? e.status : 500 }
  }
  assert.equal(statusFor({ mime: 'image/png', dataBase64: png }), 200)
  assert.equal(statusFor({ mime: 'image/png' }), 400)
  assert.equal(statusFor({ mime: 'application/pdf', dataBase64: png }), 415)
  assert.equal(statusFor({ mime: 'image/png', dataBase64: Buffer.alloc(MAX + 1).toString('base64') }), 413)
})
