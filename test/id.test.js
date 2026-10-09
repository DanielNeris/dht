const test = require('node:test')
const assert = require('node:assert')
const { randomId, hash, distance, compareDistance, commonPrefixLength } = require('../lib/id')

test('randomId returns 32 random bytes', () => {
  const a = randomId()
  assert.strictEqual(a.length, 32)
  assert.ok(!a.equals(randomId()))
})

test('hash is deterministic and 32 bytes', () => {
  assert.strictEqual(hash('key1').length, 32)
  assert.ok(hash('key1').equals(hash('key1')))
  assert.ok(!hash('key1').equals(hash('key2')))
})

test('distance to yourself is zero and distance is symmetric', () => {
  const a = randomId()
  const b = randomId()
  assert.ok(distance(a, a).equals(Buffer.alloc(32)))
  assert.ok(distance(a, b).equals(distance(b, a)))
})

test('compareDistance', () => {
  const target = Buffer.alloc(32)
  const near = Buffer.alloc(32)
  const far = Buffer.alloc(32)
  near[31] = 1
  far[0] = 0x80
  assert.ok(compareDistance(near, far, target) < 0)
  assert.ok(compareDistance(far, near, target) > 0)
  assert.strictEqual(compareDistance(near, near, target), 0)
})

test('commonPrefixLength: known cases', () => {
  const a = Buffer.alloc(32)
  const b = Buffer.alloc(32)
  assert.strictEqual(commonPrefixLength(a, b), 256)
  b[0] = 0b10000000
  assert.strictEqual(commonPrefixLength(a, b), 0)
  b[0] = 0b00000001
  assert.strictEqual(commonPrefixLength(a, b), 7)
  b[0] = 0
  b[1] = 0b00100000
  assert.strictEqual(commonPrefixLength(a, b), 10)
  b[1] = 0
  b[31] = 1
  assert.strictEqual(commonPrefixLength(a, b), 255)
})

test('each bucket gets about half of the previous one', () => {
  const self = randomId()
  const counts = new Array(257).fill(0)
  const N = 20000
  for (let i = 0; i < N; i++) counts[commonPrefixLength(self, randomId())]++
  assert.ok(Math.abs(counts[0] / N - 0.5) < 0.02)
  assert.ok(Math.abs(counts[1] / N - 0.25) < 0.02)
  assert.ok(Math.abs(counts[2] / N - 0.125) < 0.02)
})
