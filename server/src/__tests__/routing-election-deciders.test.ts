/**
 * Who takes an unaddressed turn when the room has a decider.
 *
 * `role` is display text and role-fit signal; `decisionScope` is authority. An
 * agent accountable for the call should take the turn before whoever happens to
 * sort first by id, and rank should break ties between deciders rather than
 * insertion order.
 *
 * Run: node --import tsx --test server/src/__tests__/routing-election-deciders.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { electLineup, orderCandidates, type ElectionCandidate } from '../agents/routing-election.js'

const free = (id: string, extra: Partial<ElectionCandidate> = {}): ElectionCandidate =>
  ({ id, role: null, status: 'avail', statusUpdatedAt: null, ...extra })

test('without deciders, order is availability then id — unchanged', () => {
  const ids = orderCandidates([free('c'), free('a'), free('b')])
  assert.deepEqual(ids, ['a', 'b', 'c'])
})

test('a decider is ordered first even when their id sorts last', () => {
  const ids = orderCandidates([
    free('a'),
    free('z', { decisionScope: 'architecture calls' }),
  ])
  assert.deepEqual(ids, ['z', 'a'])
})

test('rank breaks ties between deciders (lead before senior before peer)', () => {
  const ids = orderCandidates([
    free('a', { decisionScope: 'peer scope', decisionRank: 20 }),
    free('b', { decisionScope: 'lead scope', decisionRank: 0 }),
    free('c', { decisionScope: 'senior scope', decisionRank: 10 }),
  ])
  assert.deepEqual(ids, ['b', 'c', 'a'])
})

test('a blank or whitespace scope does not make someone a decider', () => {
  const ids = orderCandidates([
    free('a', { decisionScope: '   ' }),
    free('b', { decisionScope: '' }),
    free('c'),
  ])
  assert.deepEqual(ids, ['a', 'b', 'c'])
})

test('availability still outranks authority: a busy lead is not elected first', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')
  const candidates = [
    free('lead', { decisionScope: 'everything', decisionRank: 0, status: 'working', statusUpdatedAt: new Date(now - 1000) }),
    free('worker', { status: 'avail' }),
  ]
  const election = electLineup(null, candidates, { now, leaseMs: 300_000 })
  assert.equal(election?.primary, 'worker')
  // The lead is still next in line for the lease sweep.
  assert.deepEqual(election?.lineup, ['worker', 'lead'])
})

test('a router proposal still wins over the decider when it is a real candidate', () => {
  // Role fit is the signal the router has and code does not; authority only
  // decides when the router has no opinion.
  const election = electLineup('specialist', [
    free('lead', { decisionScope: 'all calls', decisionRank: 0 }),
    free('specialist'),
  ])
  assert.equal(election?.primary, 'specialist')
})

test('an empty room elects nobody', () => {
  assert.equal(electLineup(null, []), null)
})
