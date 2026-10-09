const { commonPrefixLength } = require('./id')

class RoutingTable {
  constructor(id, k = 20) {
    this.id = id
    this.k = k
    this.buckets = Array.from({ length: 256 }, () => [])
  }

  bucketIndex(id) {
    return commonPrefixLength(this.id, id)
  }

  get size() {
    let total = 0
    for (const bucket of this.buckets) {
      total += bucket.length
    }
    return total
  }

  add(peer) {
    const i = this.bucketIndex(peer.id)

    // 1. it's us
    if (i === 256) return { status: 'self' }

    const bucket = this.buckets[i]
    const j = bucket.findIndex(p => p.id.equals(peer.id))

    // 2. already known: move it to the tail (most recently seen)
    // push the incoming peer, not bucket[j], so a new host/port replaces the old one
    if (j !== -1) {
      bucket.splice(j, 1)
      bucket.push(peer)
      return { status: 'updated' }
    }

    // 3. there's room: append to the tail
    if (bucket.length < this.k) {
      bucket.push(peer)
      return { status: 'added' }
    }

    // 4. bucket is full: change nothing, report the least-recently seen peer.
    // The node pings it and decides whether to evict (the table can't talk to the network)
    return { status: 'full', oldest: bucket[0] }
  }
}

module.exports = { RoutingTable }
