const test = require('node:test')
const assert = require('node:assert')
const dgram = require('dgram')
const { RPC } = require('../lib/rpc')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// Two RPCs where `b` echoes every request back, after an optional delay.
async function pair({ timeout = 300, delay = () => 0 } = {}) {
  const a = new RPC(timeout)
  const b = new RPC()
  await a.bind()
  const addr = await b.bind()
  b.on('request', (msg, rinfo) => {
    setTimeout(() => b.reply({ host: rinfo.address, port: rinfo.port }, msg.t, { echo: msg.n }), delay())
  })
  return { a, b, toB: { host: '127.0.0.1', port: addr.port } }
}

// A plain UDP socket, to send raw packets.
async function rawSocket() {
  const s = dgram.createSocket('udp4')
  await new Promise(resolve => s.bind(0, '127.0.0.1', resolve))
  return s
}

test('bind resolves with the address the OS picked', async () => {
  const rpc = new RPC()
  const addr = await rpc.bind()
  assert.strictEqual(addr.address, '127.0.0.1')
  assert.ok(addr.port > 0)
  await rpc.close()
})

test('bind rejects when the port is taken', async () => {
  const a = new RPC()
  const { port } = await a.bind()
  const b = new RPC()
  await assert.rejects(b.bind(port), /EADDRINUSE/)
  await a.close()
})

test('each response finds its request by tid, even out of order', async () => {
  const { a, b, toB } = await pair({ delay: () => Math.random() * 50 })
  const res = await Promise.all([1, 2, 3, 4, 5].map(n => a.request(toB, { n })))
  assert.deepStrictEqual(res.map(r => r.echo), [1, 2, 3, 4, 5])
  assert.strictEqual(res[0].y, 'r')
  assert.strictEqual(a.inflight.size, 0)
  await a.close()
  await b.close()
})

test('tid wraps around after 0xffff', async () => {
  const { a, b, toB } = await pair()
  a.nextTid = 0xffff
  const res = await a.request(toB, { n: 1 })
  assert.strictEqual(res.t, 0)
  await a.close()
  await b.close()
})

test('a request to a dead peer times out and leaves nothing behind', async () => {
  const a = new RPC(100)
  await a.bind()
  const silent = await rawSocket() // bound, never answers
  await assert.rejects(a.request({ host: '127.0.0.1', port: silent.address().port }, {}), /REQUEST_TIMEOUT/)
  assert.strictEqual(a.inflight.size, 0)
  silent.close()
  await a.close()
})

test('a response arriving after the timeout is ignored', async () => {
  const { a, b, toB } = await pair({ timeout: 50, delay: () => 150 })
  await assert.rejects(a.request(toB, { n: 1 }), /REQUEST_TIMEOUT/)
  await wait(200) // the late answer arrives now: it must not throw or resolve anything
  assert.strictEqual(a.inflight.size, 0)
  await a.close()
  await b.close()
})

test('a response from an address we did not ask is ignored', async () => {
  const a = new RPC(200)
  await a.bind()
  const target = await rawSocket()
  const intruder = await rawSocket()
  target.on('message', buf => {
    const { t } = JSON.parse(buf)
    // someone else answers with the right tid
    intruder.send(JSON.stringify({ t, y: 'r', fake: true }), a.socket.address().port, '127.0.0.1')
  })
  await assert.rejects(a.request({ host: '127.0.0.1', port: target.address().port }, {}), /REQUEST_TIMEOUT/)
  target.close()
  intruder.close()
  await a.close()
})

test('garbage from the network is ignored', async () => {
  const rpc = new RPC()
  const { port } = await rpc.bind()
  const requests = []
  rpc.on('request', msg => requests.push(msg))

  const s = await rawSocket()
  for (const junk of ['not json', 'null', '42', '"text"', JSON.stringify({ t: 1, y: 'x' }), JSON.stringify({ t: 9, y: 'r' })]) {
    s.send(junk, port, '127.0.0.1')
  }
  s.send(JSON.stringify({ t: 1, y: 'q', cmd: 'PING' }), port, '127.0.0.1')
  await wait(100)

  assert.strictEqual(requests.length, 1) // only the real request got through
  assert.strictEqual(requests[0].cmd, 'PING')
  s.close()
  await rpc.close()
})

test('close rejects requests still in flight', async () => {
  const a = new RPC(5000)
  await a.bind()
  const silent = await rawSocket()
  const pending = a.request({ host: '127.0.0.1', port: silent.address().port }, {})
  await a.close()
  await assert.rejects(pending, /RPC_CLOSED/)
  assert.strictEqual(a.inflight.size, 0)
  silent.close()
})
