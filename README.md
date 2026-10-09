# dht

A [Kademlia](https://pdos.csail.mit.edu/~petar/papers/maymounkov-kademlia-lncs.pdf) distributed hash table, written from scratch in Node.js over raw UDP. Zero dependencies.

Any node can store a value and any other node can find it, with no server and no node knowing the whole network.

```
1000 nodes · each one knows 4.7% of the network · lookups find the right 20 nodes 100% of the time
```

## Quick start

```sh
npm test                 # unit tests
node sim/hops.js 1000    # 1000 real UDP nodes in one process, measured
```

Or talk to it by hand, one node per terminal:

```sh
node bin/dht.js --port 5001
node bin/dht.js --port 5002 --bootstrap 127.0.0.1:5001
node bin/dht.js --port 5003 --bootstrap 127.0.0.1:5001
```

```
ac9a5804> put key1 val1
stored on 3/3 replicas

64efba31> get key1
"val1" from local storage (0 rounds)
```

Commands: `put <key> <value>`, `get <key>`, `table`, `storage`, `quit`.

## How it works

**Ids and distance** · `lib/id.js`
Nodes pick a random 256-bit id. Keys become ids with SHA-256. Distance is `a XOR b`: the more leading bits two ids share, the closer they are. A value lives on the nodes whose ids are closest to `hash(key)`.

**Routing table** · `lib/routing-table.js`
256 buckets, one per number of leading bits shared with our id. Each holds at most k = 20 peers, least recently seen first. Half the network falls in bucket 0, a quarter in bucket 1, and so on, so a node knows many peers near it and few far away.

**RPC over UDP** · `lib/rpc.js`
UDP has no connections and no replies, just packets. This layer adds a transaction id to match each response to its request, and a timeout so a dead peer fails instead of hanging. One socket talks to every peer.

**The node** · `lib/node.js`
Four RPCs: `PING`, `FIND_NODE`, `FIND_VALUE`, `STORE`. Every message carries the sender's id, so the table fills up from normal traffic.

- **lookup**: ask the α = 3 closest peers we know "who is closer to X?", add their answers, repeat. Stop when the k closest have all answered.
- **bootstrap**: ping one known address, then look up our own id. That fills our near buckets and makes our neighbours learn about us.
- **put**: lookup `hash(key)`, then `STORE` on the 20 closest nodes.
- **get**: same lookup with `FIND_VALUE`, stopping at the first node that has it.
- **full bucket**: ping the oldest peer first. Alive, it stays; dead, the newcomer takes its place.

## Results

From `sim/hops.js` on localhost, k = 20:

| nodes | α | table size | lookup rounds | found the real 20 closest | get rounds |
|---|---|---|---|---|---|
| 200 | 3 | 41 (20.6%) | 7.5 | 100% | 1.1 |
| 1000 | 3 | 47 (4.7%) | 8.4 | 100% | 1.8 |
| 1000 | 1 | 44 (4.4%) | 21.7 | 100% | 2.4 |

- **Tables grow with log N.** 5x more nodes added only 6 peers per table.
- **A get takes 1 to 2 rounds.** Each answer brings up to 20 closer peers, and the get stops at the first replica.
- **A full lookup takes ~k/α rounds.** It must hear from all 20 closest, 3 at a time. With α = 1 it needs 20+.
- **Values survive churn.** With 15 of the 20 replicas killed, the get still succeeds.

## Design choices

| | why |
|---|---|
| UDP, not TCP | no handshake per peer, one socket for everyone, works with NAT hole punching |
| replicate to k = 20 nodes | a value is lost only if all 20 leave at once |
| ping before evicting | long-lived peers tend to stay up, and flooding us with new ids can't push out live peers (eclipse attack) |
| address from the packet, not the message | behind a NAT a node doesn't know its own public address |
| responses only from the asked address | otherwise anyone guessing a 16-bit tid could inject answers |

## Layout

```
lib/id.js              ids, XOR distance, bucket index
lib/routing-table.js   k-buckets
lib/rpc.js             request/response over UDP
lib/node.js            RPCs, lookup, bootstrap, put/get
bin/dht.js             interactive CLI
sim/hops.js            N-node simulation
test/                  node:test
```

## Next

- [ ] Refresh buckets with no traffic for an hour; tolerate a few timeouts before removing a peer
- [ ] TTL on stored values and hourly republishing
- [ ] Keep α requests in flight at all times instead of waiting for each round
- [ ] Binary wire format with [compact-encoding](https://github.com/holepunchto/compact-encoding)
- [ ] Signed mutable values (Ed25519)
- [ ] Compare with Holepunch's [dht-rpc](https://github.com/holepunchto/dht-rpc)
