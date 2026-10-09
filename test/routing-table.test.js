const test = require('node:test')
const assert = require('node:assert')
const { randomId, compareDistance } = require('../lib/id')
const { RoutingTable } = require('../lib/routing-table')

const peer = (id, port = 1) => ({ id, host: '127.0.0.1', port })

function idInBucket(table, i) {
  while (true) {
    const id = randomId()
    if (table.bucketIndex(id) === i) return id
  }
}

test('ignores self', () => {
  const self = randomId()
  const table = new RoutingTable(self)
  assert.strictEqual(table.add(peer(self)).status, 'self')
  assert.strictEqual(table.size, 0)
})

test('bucket holds at most k peers and reports the oldest when full', () => {
  const table = new RoutingTable(randomId(), 3)
  const peers = [0, 1, 2].map(() => peer(idInBucket(table, 0)))
  for (const p of peers) assert.strictEqual(table.add(p).status, 'added')

  const res = table.add(peer(idInBucket(table, 0)))
  assert.strictEqual(res.status, 'full')
  assert.strictEqual(res.oldest, peers[0])
  assert.strictEqual(table.size, 3)
})

test('re-adding moves a peer to the tail with its new address', () => {
  const table = new RoutingTable(randomId(), 3)
  const peers = [0, 1, 2].map(() => peer(idInBucket(table, 0)))
  for (const p of peers) table.add(p)

  assert.strictEqual(table.add(peer(peers[0].id, 9)).status, 'updated')
  const bucket = table.buckets[0]
  assert.ok(bucket[2].id.equals(peers[0].id))
  assert.strictEqual(bucket[2].port, 9)
  assert.strictEqual(table.add(peer(idInBucket(table, 0))).oldest, peers[1])
})

test('remove', () => {
  const table = new RoutingTable(randomId())
  const p = peer(randomId())
  table.add(p)
  assert.strictEqual(table.remove(p.id), true)
  assert.strictEqual(table.remove(p.id), false)
  assert.strictEqual(table.size, 0)
})

test('closest returns the n nearest peers in order', () => {
  const table = new RoutingTable(randomId())
  for (let i = 0; i < 2000; i++) table.add(peer(randomId()))

  const target = randomId()
  const expected = table.buckets.flat().sort((a, b) => compareDistance(a.id, b.id, target)).slice(0, 10)
  assert.deepStrictEqual(table.closest(target, 10).map(p => p.id), expected.map(p => p.id))
})
