/**
 * Validation for local profile edits (name + email).
 *
 * The personal build has no OAuth provider to source the user's identity
 * from, so the owner may edit their own name and email. Parsing is pure so
 * the rules are unit-testable without an HTTP or database harness.
 *
 * Kept deliberately permissive: this is one person's local account, not a
 * signup funnel. The only real invariants are "non-empty, sane length" for
 * the name and "looks like an address" for the email — uniqueness is enforced
 * against the other local accounts by the caller.
 */
export interface ProfilePatch {
  displayName?: string
  email?: string
}

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileValidationError'
  }
}

const MAX_NAME_LENGTH = 64
const MAX_EMAIL_LENGTH = 254

/** Loose on purpose — enough to catch a typo, not an RFC 5322 validator. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeProfilePatch(body: unknown): ProfilePatch {
  const input = (body ?? {}) as { displayName?: unknown; email?: unknown }
  const patch: ProfilePatch = {}

  if (input.displayName !== undefined) {
    const name = String(input.displayName ?? '').replace(/\s+/g, ' ').trim()
    if (!name) throw new ProfileValidationError('name cannot be empty')
    if (name.length > MAX_NAME_LENGTH) {
      throw new ProfileValidationError(`name must be ${MAX_NAME_LENGTH} characters or fewer`)
    }
    patch.displayName = name
  }

  if (input.email !== undefined) {
    const email = String(input.email ?? '').trim().toLowerCase()
    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) {
      throw new ProfileValidationError('enter a valid email address')
    }
    patch.email = email
  }

  if (patch.displayName === undefined && patch.email === undefined) {
    throw new ProfileValidationError('nothing to update')
  }
  return patch
}
