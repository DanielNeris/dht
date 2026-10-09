const { randomId, parseId } = require('./id')
const { RoutingTable } = require('./routing-table')
const { RPC } = require('./rpc')

class DHTNode {
  constructor({ id = randomId(), k = 20, timeout = 1000 } = {}) {
    this.id = id // our 32-byte id, picked at random: nobody hands out ids
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

  close() {
    return this.rpc.close()
  }

  // ---------------------------------------------------------------------------
  // Outgoing requests (the four Kademlia RPCs)
  // ---------------------------------------------------------------------------

  // Is this peer alive? Also how we learn the id of an address we only know by host:port.
  ping(peer) {
    return this._request(peer, 'PING')
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

      // Unknown commands are ignored: the sender will time out.
    }
  }
}

module.exports = { DHTNode }
