// Request/response on top of UDP.
//
// UDP only moves loose packets: no connection, no delivery guarantee, no notion
// of "answer". This layer adds the two things a DHT needs on top of it:
//   - a transaction id (tid), so each response finds the request it answers
//   - a timeout, so asking a dead peer fails instead of waiting forever
//
// Wire format, JSON for readability:
//   request  { t: <tid>, y: 'q', ...body }
//   response { t: <tid>, y: 'r', ...body }

const dgram = require('dgram')
const { EventEmitter } = require('events')

class RPC extends EventEmitter {
  constructor(timeout = 1000) {
    super()
    this.timeout = timeout
    this.inflight = new Map() // tid → { to, resolve, reject, timer }
    this.nextTid = 0
    this.socket = dgram.createSocket('udp4') // one socket talks to every peer
    this.socket.on('message', (buf, rinfo) => this._onmessage(buf, rinfo))
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  // Start listening. Port 0 lets the OS pick a free one.
  bind(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject)
      this.socket.bind(port, host, () => {
        this.socket.off('error', reject)
        resolve(this.socket.address())
      })
    })
  }

  close() {
    // don't leave callers hanging on requests that can never complete
    for (const entry of this.inflight.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('RPC_CLOSED'))
    }
    this.inflight.clear()
    return new Promise(resolve => this.socket.close(resolve))
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  // Send a request and wait for its response, or fail after this.timeout ms.
  request(to, body) {
    const tid = this.nextTid = (this.nextTid + 1) & 0xffff // 16-bit counter, wraps around

    return new Promise((resolve, reject) => {
      // give up after this.timeout ms: UDP never tells us the peer is gone
      const timer = setTimeout(() => {
        this.inflight.delete(tid)
        reject(new Error('REQUEST_TIMEOUT'))
      }, this.timeout)

      // keyed by tid: that's the only thing the response carries back
      this.inflight.set(tid, { to, resolve, reject, timer })

      this._send(to, { t: tid, y: 'q', ...body })
    })
  }

  // Answer a request: same tid, type 'r', plus the body fields.
  reply(to, tid, body) {
    this._send(to, { t: tid, y: 'r', ...body })
  }

  // One JS object → one UDP packet.
  _send(to, msg) {
    this.socket.send(Buffer.from(JSON.stringify(msg)), to.port, to.host)
  }

  // ---------------------------------------------------------------------------
  // Receiving
  // ---------------------------------------------------------------------------

  _onmessage(buf, rinfo) {
    // garbage from the network is normal: never let it crash us
    let msg
    try {
      msg = JSON.parse(buf)
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null) return

    // Requests go to whoever listens (the node): this layer doesn't know what to answer.
    if (msg.y === 'q') this.emit('request', msg, rinfo)
    else if (msg.y === 'r') this._onresponse(msg, rinfo)
  }

  _onresponse(msg, rinfo) {
    const entry = this.inflight.get(msg.t)
    if (!entry) return // late (already timed out) or never asked

    // only accept the answer from the address we asked,
    // otherwise anyone guessing a 16-bit tid could inject fake answers
    if (rinfo.address !== entry.to.host || rinfo.port !== entry.to.port) return

    clearTimeout(entry.timer)
    this.inflight.delete(msg.t)
    entry.resolve(msg) // wakes up the `await rpc.request(...)`
  }
}

module.exports = { RPC }
