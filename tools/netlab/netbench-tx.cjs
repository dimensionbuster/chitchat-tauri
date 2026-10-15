// 원시 UDP/TCP 송신 측정 (WSL에서 실행): node netbench-tx.cjs <Windows 호스트 IP>
const dgram = require('node:dgram')
const net = require('node:net')

const host = process.argv[2]
const udp = dgram.createSocket('udp4')
const packet = Buffer.alloc(1200)
let sent = 0
const t = Date.now()

function loop() {
  for (let i = 0; i < 200; i++) {
    udp.send(packet, 7790, host)
    sent++
  }
  if (Date.now() - t < 8000) return setImmediate(loop)
  console.log(`UDP 송신 시도 ${((sent * 1200) / 1048576 / 8).toFixed(1)} MB/s`)
  const c = net.connect(7791, host, () => {
    const chunk = Buffer.alloc(65536)
    let n = 0
    const write = () => {
      while (n < 2048) {
        n++
        if (!c.write(chunk)) return c.once('drain', write)
      }
      c.end()
    }
    write()
  })
  c.on('close', () => process.exit())
}
loop()
