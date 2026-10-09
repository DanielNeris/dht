const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { spawn } = require('child_process')
const { once } = require('events')

const BIN = path.join(__dirname, '..', 'bin', 'dht.js')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// Start the CLI as a real process and talk to it through stdin/stdout.
function cli(args = []) {
  const proc = spawn(process.execPath, [BIN, ...args])
  let out = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { out += d })

  return {
    // Wait until `pattern` shows up in the output written after position `from`.
    async waitFor(pattern, from = 0) {
      for (let i = 0; i < 250; i++) {
        const match = out.slice(from).match(pattern)
        if (match) return match
        await wait(20)
      }
      throw new Error(`timed out waiting for ${pattern}, got:\n${out}`)
    },
    // Type a command and wait for its answer.
    run(line, pattern) {
      const from = out.length
      proc.stdin.write(line + '\n')
      return this.waitFor(pattern, from)
    },
    async quit() {
      proc.stdin.write('quit\n')
      const [code] = await once(proc, 'exit')
      return code
    }
  }
}

test('three nodes in three processes: join, put, get, inspect, quit', async () => {
  const t1 = cli(['--port', '0'])
  const port = (await t1.waitFor(/addr 127\.0\.0\.1:(\d+)/))[1]

  const t2 = cli(['--bootstrap', `127.0.0.1:${port}`])
  await t2.waitFor(/joined: 1 peers in table/)
  const t3 = cli(['--bootstrap', `localhost:${port}`]) // localhost is accepted too
  await t3.waitFor(/joined: 2 peers in table/)

  // 3 nodes < k = 20, so everyone is a replica
  await t3.run('put key1 val1', /stored on 3\/3 replicas/)
  await t2.run('get key1', /"val1" from local storage \(0 rounds\)/)
  await t2.run('get nada', /not found \(\d+ rounds\)/)
  await t2.run('storage', /[0-9a-f]{8} = "val1"/)
  await t2.run('table', /2 peers\n {2}bucket +\d+: [0-9a-f]{8}@\d+/)

  // a node that joins after the put doesn't hold the value: its get goes to the network
  const t4 = cli(['--bootstrap', `127.0.0.1:${port}`])
  await t4.waitFor(/joined/)
  await t4.run('put spaced Daniel Neris', /stored on 4\/4 replicas/) // values can contain spaces
  await t4.run('get key1', /"val1" from [0-9a-f]{8}@\d+ \(\d+ rounds\)/)

  for (const t of [t1, t2, t3, t4]) assert.strictEqual(await t.quit(), 0)
})

test('unknown commands, empty lines and errors keep the prompt alive', async () => {
  const t = cli()
  await t.waitFor(/> $/)
  await t.run('dance', /commands: put <key> <value>, get <key>, table, storage, quit/)
  await t.run('', /> $/)
  await t.run('get', /error: /) // no key: the error is printed, the node keeps running
  await t.run('table', /0 peers/)
  assert.strictEqual(await t.quit(), 0)
})
