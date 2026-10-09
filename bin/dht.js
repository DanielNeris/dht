#!/usr/bin/env node
// Interactive DHT node. Run a few of them in separate terminals:
//
//   node bin/dht.js --port 5001
//   node bin/dht.js --port 5002 --bootstrap 127.0.0.1:5001
//
// Commands: put <key> <value>, get <key>, table, storage, quit

const { parseArgs } = require('util')
const readline = require('readline')
const { DHTNode } = require('../lib/node')

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '0' },
    bootstrap: { type: 'string', multiple: true, default: [] } // repeatable: --bootstrap a --bootstrap b
  }
})

const short = id => id.toString('hex').slice(0, 8)

// "127.0.0.1:5001" → { host, port }
function parseAddr(s) {
  const [host, port] = s.split(':')
  return { host: host === 'localhost' ? '127.0.0.1' : host, port: Number(port) }
}

async function main() {
  const node = new DHTNode()
  await node.listen(Number(values.port))
  console.log(`id   ${short(node.id)}`)
  console.log(`addr ${node.host}:${node.port}`)

  if (values.bootstrap.length) {
    const res = await node.bootstrap(values.bootstrap.map(parseAddr))
    console.log(`joined: ${node.table.size} peers in table, ${res.rounds} rounds`)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${short(node.id)}> ` })
  rl.prompt()

  rl.on('line', async line => {
    const [cmd, ...args] = line.trim().split(/\s+/)
    try {
      switch (cmd) {
        case 'put': {
          const [key, ...rest] = args // the value may contain spaces
          const res = await node.put(key, rest.join(' '))
          console.log(`stored on ${res.stored}/${res.replicas} replicas`)
          break
        }

        case 'get': {
          const res = await node.get(args[0])
          if (res.value === null) {
            console.log(`not found (${res.rounds} rounds)`)
          } else {
            const from = res.from ? `${short(res.from.id)}@${res.from.port}` : 'local storage'
            console.log(`${JSON.stringify(res.value)} from ${from} (${res.rounds} rounds)`)
          }
          break
        }

        // non-empty buckets only: index = bits in common with our id
        case 'table': {
          console.log(`${node.table.size} peers`)
          for (let i = 0; i < 256; i++) {
            const bucket = node.table.buckets[i]
            if (bucket.length) console.log(`  bucket ${String(i).padStart(3)}: ${bucket.map(p => `${short(p.id)}@${p.port}`).join(' ')}`)
          }
          break
        }

        case 'storage': {
          for (const [k, v] of node.storage) console.log(`  ${k.slice(0, 8)} = ${JSON.stringify(v)}`)
          break
        }

        case 'quit': {
          await node.close()
          process.exit(0)
        }

        case '':
          break

        default:
          console.log('commands: put <key> <value>, get <key>, table, storage, quit')
      }
    } catch (err) {
      console.log('error:', err.message)
    }
    rl.prompt() // the cases end with break, not return, so we always get here
  })
}

main()
