// 원시 UDP/TCP 수신 측정 (Windows에서 실행). WSL의 netbench-tx.cjs와 짝.
const dgram = require('node:dgram')
const net = require('node:net')

let bytes = 0, msgs = 0, t0 = 0, last = 0
const udp = dgram.createSocket('udp4')
udp.on('message', x => {
  if (!t0) t0 = Date.now()
  bytes += x.length
  msgs++
  last = Date.now()
})
udp.bind(7790, '0.0.0.0')

net.createServer(c => {
  let tb = 0, tt = 0
  c.on('data', d => {
    if (!tt) tt = Date.now()
    tb += d.length
  })
  c.on('end', () => console.log(`TCP 수신 ${(tb / 1048576 / ((Date.now() - tt) / 1000)).toFixed(1)} MB/s (${(tb / 1048576).toFixed(0)}MB)`))
}).listen(7791, '0.0.0.0')

setTimeout(() => {
  console.log(`UDP 수신 ${(bytes / 1048576 / ((last - t0) / 1000)).toFixed(1)} MB/s, ${msgs}패킷, ${(bytes / 1048576).toFixed(0)}MB`)
  process.exit()
}, Number(process.argv[2] || 25000))
