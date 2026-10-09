const dgram = require('dgram')
const { EventEmitter } = require('events')

class RPC extends EventEmitter {
  constructor(timeout = 1000) {
    super()
    this.timeout = timeout
    this.socket = dgram.createSocket('udp4')
    this.socket.on('message', (buf, rinfo) => this._onmessage(buf, rinfo))
  }

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

  // Send a JS object to { host, port } as one UDP packet.
  _send(to, msg) {
    const string = JSON.stringify(msg)
    const buffer = Buffer.from(string)
    return this.socket.send(buffer, to.port, to.host)
  }

  // Answer a request: same tid, type 'r', plus the body fields.
  reply(to, tid, body) {
    this._send(to, { t: tid, y: 'r', ...body })
  }

  _onmessage(buf, rinfo) {
    // garbage from the network is normal: never let it crash us
    let msg
    try {
      msg = JSON.parse(buf)
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null) return

    // hand it to whoever listens; the RPC layer doesn't know what to answer
    if (msg.y === 'q') this.emit('request', msg, rinfo)
    else if (msg.y === 'r') this.emit('response', msg, rinfo)
  }

  close() {
    return new Promise(resolve => this.socket.close(resolve))
  }
}

module.exports = { RPC }
