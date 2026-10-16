/**
 * Regression tests for message attachment storage references.
 *
 * Run: node --import tsx --test server/src/__tests__/storage-keys.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  messageAttachmentStorageKey,
  normalizeStorageKey,
  storageKeyFromPublicUrl,
  isStoredAvatarReference,
  avatarStorageKey,
} from '../storage-keys.js'

const PUBLIC_BASE = 'https://cdn.cumora.test/private-files'

test('rejects arbitrary text-attachment URLs, including private network targets', () => {
  for (const url of [
    'http://127.0.0.1:5181/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.8/internal',
    'https://attacker.example/payload.txt',
  ]) {
    assert.equal(messageAttachmentStorageKey({ url }, PUBLIC_BASE), null)
  }
})

test('accepts local and configured-public-base attachment URLs', () => {
  assert.equal(
    messageAttachmentStorageKey({ url: '/uploads/attachments/abc123.txt' }, PUBLIC_BASE),
    'attachments/abc123.txt',
  )
  assert.equal(
    messageAttachmentStorageKey({ url: `${PUBLIC_BASE}/attachments/abc123.txt?exp=1&sig=x` }, PUBLIC_BASE),
    'attachments/abc123.txt',
  )
})

test('accepts a valid explicit key while ignoring an unverifiable presigned URL', () => {
  assert.equal(
    messageAttachmentStorageKey({
      key: 'attachments/abc123.txt',
      url: 'https://bucket.example.invalid/presigned-object?signature=opaque',
    }, PUBLIC_BASE),
    'attachments/abc123.txt',
  )
})

test('rejects conflicting trusted key and URL references', () => {
  assert.equal(
    messageAttachmentStorageKey({
      key: 'attachments/one.txt',
      url: `${PUBLIC_BASE}/attachments/two.txt`,
    }, PUBLIC_BASE),
    null,
  )
})

test('message attachments cannot reference other storage namespaces', () => {
  assert.equal(messageAttachmentStorageKey({ key: 'avatars/person.png' }, PUBLIC_BASE), null)
  assert.equal(messageAttachmentStorageKey({ key: 'email-attachments/mail.txt' }, PUBLIC_BASE), null)
})

test('rejects traversal, encoded traversal, backslashes, and empty keys', () => {
  for (const key of [
    'attachments/../../etc/passwd',
    'attachments/%2e%2e/secret.txt',
    'attachments\\..\\secret.txt',
    'attachments/',
  ]) {
    assert.equal(normalizeStorageKey(key), null)
  }
})

test('public URL parsing is pinned to the configured origin and base path', () => {
  assert.equal(
    storageKeyFromPublicUrl(`${PUBLIC_BASE}/attachments/report.md`, PUBLIC_BASE),
    'attachments/report.md',
  )
  assert.equal(
    storageKeyFromPublicUrl('https://cdn.cumora.test/other/attachments/report.md', PUBLIC_BASE),
    null,
  )
  assert.equal(
    storageKeyFromPublicUrl('https://cdn.cumora.test.evil.example/private-files/attachments/report.md', PUBLIC_BASE),
    null,
  )
})

// The personal build stores uploads on disk and (in the packaged app) hands
// the renderer ABSOLUTE local URLs, because the renderer origin is
// `app://cumora` where a relative `/uploads/...` cannot resolve.
test('absolute local uploads URLs map back to keys when an uploads base is set', () => {
  const base = 'http://127.0.0.1:5181'
  assert.equal(
    storageKeyFromPublicUrl(`${base}/uploads/attachments/photo.jpg`, '', base),
    'attachments/photo.jpg',
  )
  assert.equal(
    storageKeyFromPublicUrl('http://127.0.0.1:9999/uploads/attachments/photo.jpg', '', base),
    null,
    'a different origin must not be treated as local storage',
  )
  assert.equal(
    messageAttachmentStorageKey({ url: `${base}/uploads/attachments/photo.jpg` }, '', base),
    'attachments/photo.jpg',
  )
  // Without the base configured, behaviour is unchanged (relative only).
  assert.equal(
    storageKeyFromPublicUrl(`${base}/uploads/attachments/photo.jpg`, ''),
    null,
  )
})

// Avatar columns are rendered straight into <img src>, so the API refuses
// anything that is not a stored avatar reference. This is what stops a typo
// (`/api/uploads/…`, a wrong port, a foreign host) from blanking a portrait.
test('isStoredAvatarReference accepts the shapes the app produces', () => {
  const base = 'http://127.0.0.1:5181'
  for (const value of [
    'avatars/iris-d4de.jpg',
    '/uploads/avatars/iris-d4de.jpg',
    `${base}/uploads/avatars/iris-d4de.jpg`,
  ]) {
    assert.equal(isStoredAvatarReference(value, '', base), true, value)
  }
  // Uploads base unset (dev / same-origin): the relative form still works.
  assert.equal(isStoredAvatarReference('/uploads/avatars/x.png', ''), true)
})

test('isStoredAvatarReference rejects typos, foreign hosts and other prefixes', () => {
  const base = 'http://127.0.0.1:5181'
  for (const value of [
    'http://127.0.0.1:5181/api/uploads/avatars/iris-d4de.jpg', // the /api typo
    'https://evil.example/avatars/iris-d4de.jpg',
    '/uploads/attachments/photo.jpg',
    'avatars/', // key with no object
    'just some text',
    '',
  ]) {
    assert.equal(isStoredAvatarReference(value, '', base), false, value)
  }
})

test('avatarStorageKey resolves both stored shapes and nothing else', () => {
  const base = 'http://127.0.0.1:5181'
  assert.equal(avatarStorageKey('avatars/iris-d4de.jpg', '', base), 'avatars/iris-d4de.jpg')
  assert.equal(avatarStorageKey(`${base}/uploads/avatars/iris-d4de.jpg`, '', base), 'avatars/iris-d4de.jpg')
  assert.equal(avatarStorageKey('/uploads/avatars/x.png', ''), 'avatars/x.png')
  assert.equal(avatarStorageKey('attachments/report.pdf', '', base), null)
  assert.equal(avatarStorageKey('https://cdn.example/avatars/x.jpg', '', base), null)
})
