/**
 * Local profile-edit validation. The personal build owns its identity, so
 * these are the only guards between the form and the users/participants rows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProfilePatch, ProfileValidationError } from '../profile.js'

test('accepts and normalises a name + email patch', () => {
  assert.deepEqual(
    normalizeProfilePatch({ displayName: '  Seiko   Des  ', email: '  Seiko@Example.COM ' }),
    { displayName: 'Seiko Des', email: 'seiko@example.com' },
  )
})

test('partial patches are allowed', () => {
  assert.deepEqual(normalizeProfilePatch({ displayName: 'Seiko' }), { displayName: 'Seiko' })
  assert.deepEqual(normalizeProfilePatch({ email: 'a@b.co' }), { email: 'a@b.co' })
})

test('rejects an empty or oversized name', () => {
  assert.throws(() => normalizeProfilePatch({ displayName: '   ' }), ProfileValidationError)
  assert.throws(() => normalizeProfilePatch({ displayName: 'x'.repeat(65) }), ProfileValidationError)
  assert.ok(normalizeProfilePatch({ displayName: 'x'.repeat(64) }).displayName)
})

test('rejects malformed email addresses', () => {
  for (const email of ['not-an-email', 'a@b', '@b.co', 'a@.co', 'a b@c.co', '']) {
    assert.throws(() => normalizeProfilePatch({ email }), ProfileValidationError, email)
  }
  assert.equal(normalizeProfilePatch({ email: 'x.y+z@sub.example.co' }).email, 'x.y+z@sub.example.co')
})

test('rejects a patch with nothing to change', () => {
  assert.throws(() => normalizeProfilePatch({}), ProfileValidationError)
  assert.throws(() => normalizeProfilePatch(null), ProfileValidationError)
})
