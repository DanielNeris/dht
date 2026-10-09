// The node's address book: who we know, grouped by distance.
//
// 256 buckets, one per possible common prefix length with our id. Each holds at
// most k peers, ordered from least to most recently seen. So we know many peers
// near us and few far away, which is enough to reach anyone in ~log(N) steps.

const { commonPrefixLength, compareDistance } = require('./id')

class RoutingTable {
  constructor(id, k = 20) {
    this.id = id
    this.k = k
    this.buckets = Array.from({ length: 256 }, () => []) // not fill([]): that would share one array
  }

  // Which bucket an id falls in (256 means it's us).
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

  // We just heard from this peer. Returns { status }:
  //   'self'    it's us, ignored
  //   'updated' already known, moved to the tail (most recently seen)
  //   'added'   new, appended to the tail
  //   'full'    bucket has k peers; `oldest` is who the node should ping before evicting.
  // The table never evicts on its own: it can't talk to the network.
  add(peer) {
    const i = this.bucketIndex(peer.id)
    if (i === 256) return { status: 'self' }

    const bucket = this.buckets[i]
    const j = bucket.findIndex(p => p.id.equals(peer.id)) // .equals: === compares objects, not bytes

    if (j !== -1) {
      bucket.splice(j, 1)
      bucket.push(peer) // the incoming peer, so a new host/port replaces the old one
      return { status: 'updated' }
    }

    if (bucket.length < this.k) {
      bucket.push(peer)
      return { status: 'added' }
    }

    return { status: 'full', oldest: bucket[0] }
  }

  // Remove a peer, e.g. when it stopped answering. Returns true if it was there.
  remove(id) {
    const i = this.bucketIndex(id)
    if (i === 256) return false

    const bucket = this.buckets[i]
    const j = bucket.findIndex(p => p.id.equals(id))
    if (j === -1) return false

    bucket.splice(j, 1)
    return true
  }

  // The n peers we know closest to target, nearest first.
  // This answers FIND_NODE, and it's where every lookup starts.
  // Sorting the whole table is fine: it only holds ~k * log2(network size) peers.
  closest(target, n = this.k) {
    const all = this.buckets.flat() // new array, safe to sort in place
    all.sort((a, b) => compareDistance(a.id, b.id, target))
    return all.slice(0, n)
  }
}

module.exports = { RoutingTable }
