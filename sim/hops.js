// Spin up N real UDP nodes on localhost, in one process, and measure the DHT.
// Every result is checked against the truth, computed by looking at all nodes.
//
//   node sim/hops.js [nodes=200] [alpha=3]
//
// macOS limits open files: run `ulimit -n 4096` first for 1000+ nodes.

const { DHTNode } = require('../lib/node')
const { randomId, hash, compareDistance } = require('../lib/id')

const N = Number(process.argv[2]) || 200
const ALPHA = Number(process.argv[3]) || 3
const K = 20
const LOOKUPS = 100

const pick = arr => arr[Math.floor(Math.random() * arr.length)]
const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length

async function main() {
  // 1) start N nodes, each joining through a random node already in the network
  const nodes = []
  const t0 = Date.now()
  for (let i = 0; i < N; i++) {
    const node = new DHTNode({ k: K, alpha: ALPHA, timeout: 500 })
    await node.listen()
    if (i > 0) {
      const via = pick(nodes)
      await node.bootstrap([{ host: via.host, port: via.port }])
    }
    nodes.push(node)
  }
  console.log(`${N} nodes joined in ${Date.now() - t0} ms (k=${K}, alpha=${ALPHA})`)

  // 2) how much of the network does each node know?
  const sizes = nodes.map(n => n.table.size)
  console.log(`table size: avg ${avg(sizes).toFixed(1)}, min ${Math.min(...sizes)}, max ${Math.max(...sizes)}  (${(avg(sizes) / N * 100).toFixed(1)}% of the network)`)

  // 3) lookups for random targets, compared with the real k closest
  const rounds = []
  const accuracy = []
  for (let i = 0; i < LOOKUPS; i++) {
    const me = pick(nodes)
    const target = randomId()
    const truth = nodes
      .filter(n => n !== me)
      .sort((a, b) => compareDistance(a.id, b.id, target))
      .slice(0, K)
      .map(n => n.id.toString('hex'))
    const res = await me.lookup(target)
    const found = new Set(res.closest.map(p => p.id.toString('hex')))
    accuracy.push(truth.filter(id => found.has(id)).length / K)
    rounds.push(res.rounds)
  }
  console.log(`lookups: ${LOOKUPS}`)
  console.log(`  rounds   avg ${avg(rounds).toFixed(2)}, max ${Math.max(...rounds)}   (log2 N = ${Math.log2(N).toFixed(1)})`)
  console.log(`  found the real ${K} closest: ${(avg(accuracy) * 100).toFixed(1)}%`)

  // 4) put from one random node, get from another
  let ok = 0
  const getRounds = []
  for (let i = 0; i < 50; i++) {
    await pick(nodes).put(`key-${i}`, `value-${i}`)
    const reader = pick(nodes)
    reader.storage.delete(hash(`key-${i}`).toString('hex')) // force the get to go to the network
    const res = await reader.get(`key-${i}`)
    if (res.value === `value-${i}`) ok++
    getRounds.push(res.rounds)
  }
  console.log(`put/get: ${ok}/50 ok, get took avg ${avg(getRounds).toFixed(2)} rounds`)

  for (const n of nodes) await n.close()
}

main()
