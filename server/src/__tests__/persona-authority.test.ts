/**
 * The decider's own prompt.
 *
 * Electing someone on authority and then never telling them is the failure this
 * guards: they take the turn and still ask the room what to do.
 *
 * Run: node --import tsx --test server/src/__tests__/persona-authority.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decisionAuthoritySection } from '../agents/personas.js'

test('no scope means no authority block at all', () => {
  assert.equal(decisionAuthoritySection(null, 0), null)
  assert.equal(decisionAuthoritySection(undefined, 10), null)
  assert.equal(decisionAuthoritySection('   ', 0), null)
})

test('the scope appears verbatim and ownership is stated', () => {
  const s = decisionAuthoritySection('产品方向与优先级', 10)
  assert.ok(s)
  assert.match(s, /YOUR DECISION AUTHORITY/)
  assert.match(s, /产品方向与优先级/)
  assert.match(s, /one who calls it/)
  // A non-lead does not get the tie-break line.
  assert.doesNotMatch(s, /You are the lead/)
})

test('the lead gets the tie-break line, a peer does not', () => {
  const lead = decisionAuthoritySection('all architectural calls', 0)
  assert.match(String(lead), /break the tie/)
  const senior = decisionAuthoritySection('release timing', 10)
  assert.doesNotMatch(String(senior), /break the tie/)
  // A missing rank is treated as lead (the column defaults to 0).
  assert.match(String(decisionAuthoritySection('anything', null)), /break the tie/)
})
