const { randomId, parseId, compareDistance } = require('./id')
const { RoutingTable } = require('./routing-table')
const { RPC } = require('./rpc')

class DHTNode {
  constructor({ id = randomId(), k = 20, alpha = 3, timeout = 1000 } = {}) {
    this.id = id // our 32-byte id, picked at random: nobody hands out ids
    this.k = k // bucket size and replication factor (20 in the paper)
    this.alpha = alpha // how many peers a lookup asks in parallel (3 in the paper)
    this.table = new RoutingTable(id, k)
    this.rpc = new RPC(timeout)
    this.host = null
    this.port = 0
    this.rpc.on('request', (msg, rinfo) => this._onrequest(msg, rinfo))
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  // Start listening on UDP. Port 0 lets the OS pick a free one.
  async listen(port = 0, host = '127.0.0.1') {
    const addr = await this.rpc.bind(port, host)
    this.host = addr.address
    this.port = addr.port
  }

  // Join the network through any of the known addresses ({ host, port }).
  async bootstrap(addresses) {
    for (const addr of addresses) {
      try {
        await this.ping(addr)
      } catch {
        // that bootstrap node is down: try the next one
      }
    }
    // Looking up our own id fills our near buckets,
    // and makes the nodes near us learn about us (they see our requests).
    return this.lookup(this.id)
  }

  close() {
    return this.rpc.close()
  }

  // ---------------------------------------------------------------------------
  // Iterative lookup
  // ---------------------------------------------------------------------------

  // Find the k nodes closest to target in the whole network, knowing only a few.
  async lookup(target) {
    const seen = new Map() // hex id → { peer, queried, failed }
    let rounds = 0

    // Add a candidate, once, and never ourselves.
    const add = peer => {
      const key = peer.id.toString('hex')
      if (peer.id.equals(this.id) || seen.has(key)) return
      seen.set(key, { peer, queried: false, failed: false })
    }

    // The k closest candidates that haven't failed, nearest first.
    const closest = () => [...seen.values()]
      .filter(e => !e.failed)
      .sort((a, b) => compareDistance(a.peer.id, b.peer.id, target))
      .slice(0, this.k)

    // Start from the closest peers in our own table.
    for (const peer of this.table.closest(target)) add(peer)

    while (true) {
      // Up to alpha candidates among the k closest that we haven't asked yet.
      // When there are none, the k closest have all answered: nobody we know
      // can point us any closer, so we're done.
      const batch = closest().filter(e => !e.queried).slice(0, this.alpha)
      if (batch.length === 0) break

      rounds++
      await Promise.all(batch.map(async e => {
        e.queried = true
        try {
          const nodes = await this.findNode(e.peer, target)
          for (const peer of nodes) add(peer)
        } catch {
          // Timed out: drop it from the race so it can't hold a spot in the k closest.
          e.failed = true
        }
      }))
    }

    return { closest: closest().map(e => e.peer), rounds }
  }

  // ---------------------------------------------------------------------------
  // Outgoing requests (the four Kademlia RPCs)
  // ---------------------------------------------------------------------------

  // Is this peer alive? Also how we learn the id of an address we only know by host:port.
  ping(peer) {
    return this._request(peer, 'PING')
  }

  // Ask `peer` which nodes it knows closest to `target`.
  async findNode(peer, target) {
    const res = await this._request(peer, 'FIND_NODE', { target: target.toString('hex') })
    return decodePeers(res.nodes)
  }

  // Every request we send carries our id, so the receiver learns about us.
  async _request(peer, cmd, args = {}) {
    const res = await this.rpc.request(peer, { id: this.id.toString('hex'), cmd, ...args })

    // It answered, so it's alive: learn (or refresh) it.
    // The address is where we sent the request, which is where the answer came from.
    const id = parseId(res.id)
    if (id) this.table.add({ id, host: peer.host, port: peer.port })

    return res
  }

  // ---------------------------------------------------------------------------
  // Incoming requests
  // ---------------------------------------------------------------------------

  _onrequest(msg, rinfo) {
    const id = parseId(msg.id)
    if (!id) return // no valid sender id: ignore

    // Use the address we saw the packet come from, never one written in the message:
    // behind a NAT the sender doesn't even know its own public address.
    const from = { host: rinfo.address, port: rinfo.port }

    // Every request teaches us about its sender. This is how the table fills up
    // from normal traffic, with no separate discovery protocol.
    this.table.add({ id, ...from })

    // Every reply carries our id too, so the asker learns about us.
    const reply = body => this.rpc.reply(from, msg.t, { id: this.id.toString('hex'), ...body })

    switch (msg.cmd) {
      case 'PING': {
        reply({})
        break
      }

      case 'FIND_NODE': {
        const target = parseId(msg.target)
        if (!target) return
        reply({ nodes: encodePeers(this.table.closest(target)) })
        break
      }

      // Unknown commands are ignored: the sender will time out.
    }
  }
}

// -----------------------------------------------------------------------------
// Wire helpers
// -----------------------------------------------------------------------------

// Peers → plain objects that survive JSON (a Buffer would turn into { type, data }).
function encodePeers(peers) {
  return peers.map(p => ({ id: p.id.toString('hex'), host: p.host, port: p.port }))
}

// Plain objects from the network → peers. It's someone else's data: drop anything malformed.
function decodePeers(nodes) {
  if (!Array.isArray(nodes)) return []
  const out = []
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const id = parseId(n.id)
    if (!id) continue
    if (typeof n.host !== 'string') continue
    if (!Number.isInteger(n.port) || n.port < 1 || n.port > 65535) continue
    out.push({ id, host: n.host, port: n.port })
  }
  return out
}

module.exports = { DHTNode }
