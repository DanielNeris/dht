const crypto = require('crypto')

function randomId() {
  return crypto.randomBytes(32)
}

function hash(str) {
  return crypto.createHash('sha256').update(str).digest()
}

function distance(a, b) {
  const out = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) {
    out[i] = a[i] ^ b[i]
  }
  return out
}

function compareDistance(a, b, target) {
  const distanceA = distance(a, target)
  const distanceB = distance(b, target)

  const compare = Buffer.compare(distanceA, distanceB)

  return compare
}

function commonPrefixLength(a, b) {
  for (let i = 0; i < 32; i++) {
    const x = a[i] ^ b[i]
    if (x !== 0) {
      return i * 8 + Math.clz32(x) - 24
    }
  }
  return 256
}


// Hex string from the network → 32-byte Buffer, or null if it's not a valid id.
function parseId(hex) {
  if (typeof hex !== 'string') return null
  if (!/^[0-9a-f]{64}$/.test(hex)) return null
  return Buffer.from(hex, 'hex')
}

module.exports = { randomId, hash, distance, compareDistance, commonPrefixLength, parseId }
