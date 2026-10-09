const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const SIM = path.join(__dirname, '..', 'sim', 'hops.js')
const run = args => promisify(execFile)(process.execPath, [SIM, ...args])

test('simulation with 40 nodes and alpha = 2', async () => {
  const { stdout } = await run(['40', '2'])
  assert.match(stdout, /40 nodes joined in \d+ ms \(k=20, alpha=2\)/)
  assert.match(stdout, /found the real 20 closest: 100\.0%/)
  assert.match(stdout, /put\/get: 50\/50 ok/)
})

test('simulation with the defaults: 200 nodes, alpha = 3', async () => {
  const { stdout } = await run([])
  assert.match(stdout, /200 nodes joined in \d+ ms \(k=20, alpha=3\)/)
  assert.match(stdout, /found the real 20 closest: 100\.0%/)
  assert.match(stdout, /put\/get: 50\/50 ok/)
})
