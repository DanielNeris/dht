// Ids and the XOR distance between them.
// Nodes and keys live in the same 256-bit space, so "which node stores this key"
// becomes "which node id is closest to hash(key)".

const crypto = require('crypto')

// ---------------------------------------------------------------------------
// Making ids
// ---------------------------------------------------------------------------

// A node picks its own id at random: nobody hands out ids, and with 2^256
// possible values two nodes picking the same one is practically impossible.
function randomId() {
  return crypto.randomBytes(32)
}

// A key becomes an id with SHA-256. Deterministic (whoever puts and whoever gets
// land on the same id) and uniform (similar keys don't pile up on the same nodes).
function hash(str) {
  return crypto.createHash('sha256').update(str).digest()
}

// Hex string from the network → 32-byte Buffer, or null if it's not a valid id.
function parseId(hex) {
  if (typeof hex !== 'string') return null
  if (!/^[0-9a-f]{64}$/.test(hex)) return null
  return Buffer.from(hex, 'hex')
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

// XOR, byte by byte. The more leading bits two ids share, the more leading
// zeros the result has, so the smaller the distance.
// d(a, a) = 0 and d(a, b) = d(b, a).
function distance(a, b) {
  const out = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) {
    out[i] = a[i] ^ b[i]
  }
  return out
}

// For sort(): < 0 if a is closer to target, > 0 if b is, 0 if equal.
// Buffer.compare reads from the first byte, like comparing numbers digit by digit.
function compareDistance(a, b, target) {
  return Buffer.compare(distance(a, target), distance(b, target))
}

// How many leading bits a and b have in common (0..256).
// This is the bucket index: half the network shares 0 bits with us, a quarter 1 bit...
function commonPrefixLength(a, b) {
  for (let i = 0; i < 32; i++) {
    const x = a[i] ^ b[i]
    if (x !== 0) {
      // full bytes before this one + equal bits inside it
      // (clz32 counts zeros in 32 bits; a byte only uses the last 8)
      return i * 8 + Math.clz32(x) - 24
    }
  }
  return 256 // identical ids
}

module.exports = { randomId, hash, parseId, distance, compareDistance, commonPrefixLength }
