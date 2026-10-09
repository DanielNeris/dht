const test = require('node:test')
const assert = require('node:assert')
const dgram = require('dgram')
const { DHTNode } = require('../lib/node')
const { RPC } = require('../lib/rpc')
const { randomId, hash, compareDistance } = require('../lib/id')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const pick = arr => arr[Math.floor(Math.random() * arr.length)]
const addr = node => ({ host: node.host, port: node.port })
const knows = (node, id) => node.table.closest(id, 1).some(p => p.id.equals(id))
const closeAll = nodes => Promise.all(nodes.map(n => n.close()))

// Same bucket as `id` from anyone else's point of view: flip its last bit.
function sibling(id) {
  const s = Buffer.from(id)
  s[31] ^= 1
  return s
}

// N nodes, each joining through a random node already in the network.
async function network(n, opts = {}) {
  const nodes = []
  for (let i = 0; i < n; i++) {
    const node = new DHTNode({ timeout: 200, ...opts })
    await node.listen()
    if (i > 0) await node.bootstrap([addr(pick(nodes))])
    nodes.push(node)
  }
  return nodes
}

// A UDP socket that never answers: a dead peer.
async function silentSocket() {
  const s = dgram.createSocket('udp4')
  await new Promise(resolve => s.bind(0, '127.0.0.1', resolve))
  return s
}

// A fake peer we fully control: answers every request with `answer(msg)`, or not at all if it returns null.
async function fakePeer(answer) {
  const id = randomId()
  const rpc = new RPC()
  const { port } = await rpc.bind()
  rpc.on('request', (msg, rinfo) => {
    const body = answer(msg)
    if (body) rpc.reply({ host: rinfo.address, port: rinfo.port }, msg.t, { id: id.toString('hex'), ...body })
  })
  return { id, host: '127.0.0.1', port, rpc }
}

// ---------------------------------------------------------------------------
// PING and learning from traffic
// ---------------------------------------------------------------------------

test('one ping teaches both sides, using the address seen on the packet', async () => {
  const a = new DHTNode()
  const b = new DHTNode()
  await a.listen()
  await b.listen()
  await a.ping(addr(b)) // a only knows b's address, not its id
  assert.ok(knows(a, b.id))
  assert.ok(knows(b, a.id))
  assert.strictEqual(b.table.closest(a.id, 1)[0].host, '127.0.0.1')
  assert.strictEqual(b.table.closest(a.id, 1)[0].port, a.port)
  await closeAll([a, b])
})

test('requests without a valid sender id, or with an unknown command, get no answer', async () => {
  const node = new DHTNode()
  await node.listen()
  const rpc = new RPC(100)
  await rpc.bind()

  await assert.rejects(rpc.request(addr(node), { id: 'not-an-id', cmd: 'PING' }), /REQUEST_TIMEOUT/)
  await assert.rejects(rpc.request(addr(node), { id: randomId().toString('hex'), cmd: 'DANCE' }), /REQUEST_TIMEOUT/)
  assert.strictEqual(node.table.size, 1) // the unknown command still taught us the sender

  await rpc.close()
  await node.close()
})

test('malformed FIND_NODE, FIND_VALUE and STORE are ignored', async () => {
  const node = new DHTNode()
  await node.listen()
  const rpc = new RPC(100)
  await rpc.bind()
  const id = randomId().toString('hex')
  const ask = body => rpc.request(addr(node), { id, ...body })

  await assert.rejects(ask({ cmd: 'FIND_NODE', target: 'bad' }), /REQUEST_TIMEOUT/)
  await assert.rejects(ask({ cmd: 'FIND_VALUE', target: 'bad' }), /REQUEST_TIMEOUT/)
  await assert.rejects(ask({ cmd: 'STORE', key: 'bad', value: 'v' }), /REQUEST_TIMEOUT/)
  await assert.rejects(ask({ cmd: 'STORE', key: id, value: 42 }), /REQUEST_TIMEOUT/) // values are strings
  assert.strictEqual(node.storage.size, 0)

  await rpc.close()
  await node.close()
})

// ---------------------------------------------------------------------------
// FIND_NODE, FIND_VALUE and peer lists from the network
// ---------------------------------------------------------------------------

test('FIND_NODE answers with the closest peers we know', async () => {
  const [a, b, c] = await Promise.all([0, 1, 2].map(async () => {
    const n = new DHTNode()
    await n.listen()
    return n
  }))
  await b.ping(addr(c))
  await a.ping(addr(b))
  const found = await a.findNode(addr(b), c.id)
  assert.ok(found[0].id.equals(c.id)) // c is at distance zero from its own id
  assert.ok(!knows(a, c.id)) // hearing about c is not proof c is alive
  await closeAll([a, b, c])
})

test('peer lists from the network are validated, malformed entries dropped', async () => {
  const good = { id: randomId().toString('hex'), host: '127.0.0.1', port: 5000 }
  const id = randomId().toString('hex')
  const evil = await fakePeer(msg => {
    if (msg.cmd === 'FIND_NODE') {
      return {
        nodes: [
          null, 5, { id: 'bad', host: '127.0.0.1', port: 1 },
          { id, host: 5, port: 1 },
          { id, host: '127.0.0.1', port: 0 },
          { id, host: '127.0.0.1', port: 70000 },
          { id, host: '127.0.0.1', port: 1.5 },
          good
        ]
      }
    }
    return { nodes: 'not an array', value: 42 } // FIND_VALUE: nothing usable
  })
  const node = new DHTNode()
  await node.listen()

  const nodes = await node.findNode(evil, randomId())
  assert.strictEqual(nodes.length, 1)
  assert.strictEqual(nodes[0].id.toString('hex'), good.id)

  const res = await node.findValue(evil, randomId())
  assert.strictEqual(res.value, undefined) // 42 is not a string
  assert.deepStrictEqual(res.nodes, [])

  await evil.rpc.close()
  await node.close()
})

// ---------------------------------------------------------------------------
// Lookup and bootstrap
// ---------------------------------------------------------------------------

test('lookup finds the real k closest nodes in a 60-node network', async () => {
  const nodes = await network(60)
  const me = nodes[0]
  const target = randomId()
  const truth = nodes
    .filter(n => n !== me)
    .sort((a, b) => compareDistance(a.id, b.id, target))
    .slice(0, 20)
    .map(n => n.id.toString('hex'))

  const res = await me.lookup(target)
  assert.deepStrictEqual(res.closest.map(p => p.id.toString('hex')), truth)
  assert.ok(res.rounds > 0)
  await closeAll(nodes)
})

test('bootstrap skips dead addresses', async () => {
  const silent = await silentSocket()
  const a = new DHTNode({ timeout: 100 })
  const b = new DHTNode({ timeout: 100 })
  await a.listen()
  await b.listen()
  await b.bootstrap([{ host: '127.0.0.1', port: silent.address().port }, addr(a)])
  assert.ok(knows(b, a.id))
  silent.close()
  await closeAll([a, b])
})

test('bootstrap with no live address ends with an empty table', async () => {
  const silent = await silentSocket()
  const node = new DHTNode({ timeout: 100 })
  await node.listen()
  const res = await node.bootstrap([{ host: '127.0.0.1', port: silent.address().port }])
  assert.deepStrictEqual(res, { closest: [], rounds: 0 })
  silent.close()
  await node.close()
})

test('a peer that stops answering is dropped from the lookup and the table', async () => {
  const nodes = await network(10)
  const [me, victim] = nodes
  await me.ping(addr(victim))
  await victim.close()

  const res = await me.lookup(victim.id)
  assert.ok(!res.closest.some(p => p.id.equals(victim.id)))
  assert.ok(!knows(me, victim.id))
  await closeAll(nodes.filter(n => n !== victim))
})

// ---------------------------------------------------------------------------
// put / get
// ---------------------------------------------------------------------------

test('put stores on the k closest nodes to hash(key)', async () => {
  const nodes = await network(40)
  const res = await pick(nodes).put('key1', 'val1')
  assert.deepStrictEqual(res, { stored: 20, replicas: 20 })

  const keyHex = hash('key1').toString('hex')
  const truth = nodes.slice().sort((a, b) => compareDistance(a.id, b.id, hash('key1'))).slice(0, 20)
  assert.ok(truth.every(n => n.storage.get(keyHex) === 'val1'))
  assert.strictEqual(nodes.filter(n => n.storage.has(keyHex)).length, 20)
  await closeAll(nodes)
})

test('put counts only the replicas that answered', async () => {
  const node = new DHTNode({ timeout: 100 })
  await node.listen()
  const deaf = await fakePeer(msg => msg.cmd === 'STORE' ? null : { nodes: [] }) // ignores STORE
  await node.ping(deaf)

  const res = await node.put('key1', 'val1')
  assert.deepStrictEqual(res, { stored: 1, replicas: 2 }) // only ourselves
  await deaf.rpc.close()
  await node.close()
})

test('get finds the value through the network, from one of the replicas', async () => {
  const nodes = await network(40)
  await pick(nodes).put('key1', 'val1')
  const keyHex = hash('key1').toString('hex')
  const holders = nodes.filter(n => n.storage.has(keyHex))
  const reader = nodes.find(n => !holders.includes(n))

  const res = await reader.get('key1')
  assert.strictEqual(res.value, 'val1')
  assert.ok(holders.some(h => h.id.equals(res.from.id)))
  assert.ok(res.rounds >= 1)
  await closeAll(nodes)
})

test('get answers from local storage when we are a replica', async () => {
  const nodes = await network(5)
  await nodes[0].put('key1', 'val1') // 5 nodes < k: everyone is a replica
  assert.deepStrictEqual(await nodes[3].get('key1'), { value: 'val1', from: null, rounds: 0 })
  await closeAll(nodes)
})

test('get returns null for a key nobody stored', async () => {
  const nodes = await network(10)
  const res = await nodes[0].get('nope')
  assert.strictEqual(res.value, null)
  assert.strictEqual(res.from, null)
  assert.ok(res.rounds >= 1)
  await closeAll(nodes)
})

test('an empty string is a valid value', async () => {
  const nodes = await network(30)
  await nodes[0].put('empty', '')
  const keyHex = hash('empty').toString('hex')
  const reader = nodes.find(n => !n.storage.has(keyHex))
  assert.strictEqual((await reader.get('empty')).value, '')
  await closeAll(nodes)
})

test('the value survives 15 of its 20 replicas leaving', async () => {
  const nodes = await network(40)
  await nodes[0].put('key1', 'val1')
  const keyHex = hash('key1').toString('hex')
  const holders = nodes.filter(n => n.storage.has(keyHex))
  const reader = nodes.find(n => !holders.includes(n))
  const dead = holders.slice(0, 15)
  await closeAll(dead)

  assert.strictEqual((await reader.get('key1')).value, 'val1')
  await closeAll(nodes.filter(n => !dead.includes(n)))
})

// ---------------------------------------------------------------------------
// Full buckets: ping the oldest before evicting
// ---------------------------------------------------------------------------

test('full bucket, dead oldest: the newcomer replaces it', async () => {
  const a = new DHTNode({ k: 1, timeout: 100 }) // k = 1: one peer per bucket
  const b = new DHTNode({ timeout: 100 })
  await a.listen()
  await b.listen()
  const silent = await silentSocket()
  const deadId = sibling(b.id)
  a.table.add({ id: deadId, host: '127.0.0.1', port: silent.address().port })

  await b.ping(addr(a)) // bucket full → a pings the dead peer
  await wait(250)
  assert.ok(!knows(a, deadId))
  assert.ok(knows(a, b.id))
  silent.close()
  await closeAll([a, b])
})

test('full bucket, live oldest: it stays and the newcomer is dropped', async () => {
  const a = new DHTNode({ k: 1, timeout: 100 })
  const old = new DHTNode({ timeout: 100 })
  await a.listen()
  await old.listen()
  await old.ping(addr(a))

  const newcomer = new DHTNode({ id: sibling(old.id), timeout: 100 })
  await newcomer.listen()
  await newcomer.ping(addr(a))
  await wait(100)
  assert.ok(knows(a, old.id))
  assert.ok(!knows(a, newcomer.id))
  await closeAll([a, old, newcomer])
})

test('the oldest peer is pinged once, even if many newcomers arrive', async () => {
  const a = new DHTNode({ k: 1, timeout: 150 })
  await a.listen()
  const silent = await silentSocket()
  let pings = 0
  silent.on('message', () => pings++)
  const deadId = randomId()
  a.table.add({ id: deadId, host: '127.0.0.1', port: silent.address().port })

  // three newcomers in the dead peer's bucket, while the first ping is still pending
  const newcomers = []
  for (let i = 0; i < 3; i++) {
    const id = sibling(deadId)
    id[30] ^= i + 1 // still the same bucket, different ids
    const n = new DHTNode({ id, timeout: 150 })
    await n.listen()
    newcomers.push(n)
  }
  await Promise.all(newcomers.map(n => n.ping(addr(a))))
  await wait(300)

  assert.strictEqual(pings, 1)
  assert.ok(!knows(a, deadId))
  silent.close()
  await closeAll([a, ...newcomers])
})
