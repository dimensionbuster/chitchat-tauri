/**
 * 네트워크 랩 피어 (WSL/Linux에서 실행).
 *
 * 헤드리스 Chromium으로 앱(dist)을 열고, Tauri 명령(invoke)을 Node가 대신 구현한다
 * (블롭 저장소는 이 프로세스의 로컬 디스크). 앱의 JS 프로토콜·전송 코드는 실제 그대로 돈다.
 * 다른 네트워크 스택(WSL NAT 뒤)에 있으므로 같은 PC 두 창 테스트와 달리 실제 NAT/지연/손실을 겪는다.
 *
 * 제어 API(HTTP, --control 포트): 시나리오 러너가 Windows에서 호출한다.
 *   POST /eval        본문=JS 식 → 페이지에서 실행한 결과(JSON)
 *   POST /seed        {sizeMB} → 난수 파일을 블롭 저장소에 넣고 {id,size} 반환
 *   POST /netem       {args:"delay 100ms loss 1%"} 또는 {clear:true} (tc, root 필요)
 *   POST /corrupt     {count:N} → 다음 N개의 구간 읽기에서 1바이트를 바꿔 보낸다
 *   GET  /stat/<id>   블롭 상태
 *   POST /open        {room, name} → 채팅방 페이지 열기 (이미 열려 있으면 새로고침)
 *   POST /close       페이지 닫기 (피어 이탈 시뮬레이션)
 *
 * 사용: node peer.cjs --dist <앱 dist 경로> --data <데이터 경로> --app 7701 --control 7702
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { chromium } = require('playwright')

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => (cur.startsWith('--') ? [...acc, [cur.slice(2), arr[i + 1]]] : acc), []),
)
const DIST = path.resolve(args.dist)
const DATA = path.resolve(args.data || '/tmp/netlab-data')
const APP_PORT = Number(args.app || 7701)
const CTRL_PORT = Number(args.control || 7702)
const NAME = args.name || 'lab'
const BLOBS = path.join(DATA, 'blobs')
const STORE = path.join(DATA, 'store')
fs.mkdirSync(BLOBS, { recursive: true })
fs.mkdirSync(STORE, { recursive: true })

const SEG = 1024 * 1024
let corruptLeft = 0
const handles = new Map() // id -> fd (.part)

const idOk = id => /^[A-Za-z0-9_-]{1,80}$/.test(id)
const nameOk = n => /^[A-Za-z0-9_.-]{1,100}$/.test(n) && !n.startsWith('.')
const finalPath = id => path.join(BLOBS, id)
const partPath = id => path.join(BLOBS, `${id}.part`)

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file, { highWaterMark: 1 << 20 }).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
}

// --- Tauri 명령 구현 (src-tauri/src/blobs.rs, storage.rs와 같은 의미) ---
const commands = {
  async blob_begin({ id, size }) {
    if (!idOk(id)) throw 'invalid blob id'
    if (fs.existsSync(finalPath(id))) return { state: 'complete', size: fs.statSync(finalPath(id)).size }
    const part = partPath(id)
    const existed = fs.existsSync(part)
    const fd = fs.openSync(part, existed ? 'r+' : 'w+')
    if (fs.fstatSync(fd).size !== size) fs.ftruncateSync(fd, size)
    handles.set(id, fd)
    return { state: existed ? 'partial' : 'new', size }
  },
  async blob_write({ id, offset }, body) {
    let fd = handles.get(id)
    if (fd === undefined) {
      fd = fs.openSync(partPath(id), 'r+')
      handles.set(id, fd)
    }
    if (offset + body.length > fs.fstatSync(fd).size) throw 'write out of range'
    fs.writeSync(fd, body, 0, body.length, offset)
    return null
  },
  async blob_read({ id, offset, len }) {
    const file = fs.existsSync(finalPath(id)) ? finalPath(id) : partPath(id)
    if (!fs.existsSync(file)) throw 'not-found'
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      if (offset >= size) return Buffer.alloc(0)
      const buf = Buffer.alloc(Math.min(len, size - offset))
      fs.readSync(fd, buf, 0, buf.length, offset)
      if (corruptLeft > 0 && buf.length > 10) {
        corruptLeft--
        buf[10] ^= 0xff
      }
      return buf
    } finally {
      fs.closeSync(fd)
    }
  },
  async blob_finalize({ id, expected, adopt }) {
    const fd = handles.get(id)
    if (fd !== undefined) {
      fs.closeSync(fd)
      handles.delete(id)
    }
    const hash = await sha256File(partPath(id))
    if (expected && expected.toLowerCase() !== hash) throw `hash-mismatch:${hash}`
    const target = finalPath(adopt ? hash : id)
    if (fs.existsSync(target)) fs.rmSync(partPath(id))
    else fs.renameSync(partPath(id), target)
    return hash
  },
  async blob_sync({ id }) {
    const fd = handles.get(id)
    if (fd !== undefined) fs.fsyncSync(fd)
    return null
  },
  async blob_stat({ id }) {
    if (fs.existsSync(finalPath(id))) return { state: 'complete', size: fs.statSync(finalPath(id)).size }
    if (fs.existsSync(partPath(id))) return { state: 'partial', size: fs.statSync(partPath(id)).size }
    return { state: 'new', size: 0 }
  },
  async blob_path({ id }) {
    return fs.existsSync(finalPath(id)) ? finalPath(id) : null
  },
  async blob_delete({ id }) {
    const fd = handles.get(id)
    if (fd !== undefined) {
      fs.closeSync(fd)
      handles.delete(id)
    }
    for (const p of [finalPath(id), partPath(id)]) if (fs.existsSync(p)) fs.rmSync(p)
    return null
  },
  async blob_list() {
    return fs.readdirSync(BLOBS).filter(n => !n.endsWith('.part'))
  },
  async blob_gc() {
    return 0
  },
  async store_write({ _h }, body) {
    const name = _h['x-name']
    if (!nameOk(name)) throw `invalid file name: ${name}`
    fs.writeFileSync(path.join(STORE, name), body)
    return null
  },
  async store_read({ name }) {
    if (!nameOk(name)) throw `invalid file name: ${name}`
    const p = path.join(STORE, name)
    if (!fs.existsSync(p)) throw 'not-found'
    return fs.readFileSync(p)
  },
  async store_remove({ name }) {
    if (nameOk(name)) fs.rmSync(path.join(STORE, name), { force: true })
    return null
  },
}

// --- 앱 서버: dist + /__invoke ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' }

const appServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.startsWith('/__invoke/')) {
    const cmd = url.pathname.slice('/__invoke/'.length)
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    try {
      const fn = commands[cmd]
      if (!fn) throw `unknown command ${cmd}`
      const jsonArgs = req.headers['x-args'] ? JSON.parse(decodeURIComponent(req.headers['x-args'])) : {}
      const result = await fn({ ...jsonArgs, _h: req.headers, ...Object.fromEntries(['x-id', 'x-offset'].filter(h => req.headers[h]).map(h => [h.slice(2), h === 'x-offset' ? Number(req.headers[h]) : req.headers[h]])) }, body)
      if (Buffer.isBuffer(result)) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(result)
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result ?? null))
      }
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(String(e))
    }
    return
  }
  if (url.pathname === '/__asset') {
    const p = url.searchParams.get('p')
    if (p && p.startsWith(BLOBS) && fs.existsSync(p)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      fs.createReadStream(p).pipe(res)
    } else {
      res.writeHead(404).end()
    }
    return
  }
  let rel = url.pathname === '/' ? '/index.html' : url.pathname
  const file = path.join(DIST, path.normalize(rel))
  if (!file.startsWith(DIST) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

// --- 페이지 shim: Tauri 내부 API 최소 구현 ---
const SHIM = `
(() => {
  const base = location.origin
  let nextCb = 1
  const callbacks = {}
  const post = async (cmd, a, opts) => {
    const isRaw = a instanceof Uint8Array || a instanceof ArrayBuffer
    const headers = { 'x-args': encodeURIComponent(JSON.stringify(isRaw ? {} : (a || {}))), ...((opts && opts.headers) || {}) }
    const res = await fetch(base + '/__invoke/' + cmd, { method: 'POST', headers, body: isRaw ? a : undefined })
    if (!res.ok) throw await res.text()
    const ct = res.headers.get('content-type') || ''
    return ct.includes('json') ? res.json() : res.arrayBuffer()
  }
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    transformCallback(fn) { const id = nextCb++; callbacks[id] = fn; return id },
    unregisterCallback(id) { delete callbacks[id] },
    convertFileSrc(p) { return base + '/__asset?p=' + encodeURIComponent(p) },
    invoke(cmd, a, opts) {
      if (cmd.startsWith('plugin:app|')) return Promise.resolve('0.0.0-lab')
      if (cmd.startsWith('plugin:event|')) return Promise.resolve(1)
      if (cmd.startsWith('plugin:')) return Promise.resolve(null)
      if (['window_minimize','window_maximize','window_close','window_destroy','toggle_devtools','open_external','create_notification','close_notification','click_notification','show_main_window','open_settings','open_chat_room','open_watch_party','close_dialog','resize_and_show_dialog'].includes(cmd)) return Promise.resolve(null)
      return post(cmd, a, opts)
    },
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
  localStorage.setItem('chitchat-debug', '1')
})()
`

let browser
let context
let page
const tasks = new Map()
let taskSeq = 0

async function openRoom(room, name) {
  if (page) await page.close().catch(() => undefined)
  page = await context.newPage()
  page.on('console', m => {
    const t = m.text()
    if (/Transfer|Mesh|Provider|error|Error/.test(t)) console.log(`[${NAME}:page]`, t.slice(0, 200))
  })
  page.on('pageerror', e => console.log(`[${NAME}:pageerror]`, String(e).slice(0, 300)))
  await page.goto(`http://127.0.0.1:${APP_PORT}/index.html#/chat?roomId=${encodeURIComponent(room)}&name=${encodeURIComponent(name || NAME)}`)
  await page.waitForFunction(() => !!window.__room, null, { timeout: 30000 })
}

// --- 제어 API ---
const ctrl = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const chunks = []
  for await (const c of req) chunks.push(c)
  const bodyText = Buffer.concat(chunks).toString('utf8')
  const json = () => (bodyText ? JSON.parse(bodyText) : {})
  const reply = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj ?? null))
  }
  try {
    if (url.pathname === '/eval') {
      if (!page) return reply(409, { error: 'no page' })
      const value = await page.evaluate(`(${bodyText})`)
      return reply(200, { value })
    }
    if (url.pathname === '/task') {
      // 오래 걸리는 평가(예: 대용량 다운로드 완료 대기)를 백그라운드로 시작하고 id를 돌려준다
      if (!page) return reply(409, { error: 'no page' })
      const id = `t${++taskSeq}`
      const task = { done: false }
      tasks.set(id, task)
      page.evaluate(`(${bodyText})`).then(
        value => Object.assign(task, { done: true, value }),
        error => Object.assign(task, { done: true, error: String(error) }),
      )
      return reply(200, { id })
    }
    if (url.pathname.startsWith('/task/')) {
      const task = tasks.get(url.pathname.slice(6))
      return task ? reply(200, task) : reply(404, { error: 'unknown task' })
    }
    if (url.pathname === '/open') {
      const { room, name } = json()
      await openRoom(room, name)
      return reply(200, { ok: true })
    }
    if (url.pathname === '/close') {
      if (page) await page.close().catch(() => undefined)
      page = null
      return reply(200, { ok: true })
    }
    if (url.pathname === '/seed') {
      const { sizeMB } = json()
      const tmp = partPath(`seed-${Date.now()}`)
      const fd = fs.openSync(tmp, 'w')
      const h = crypto.createHash('sha256')
      for (let i = 0; i < sizeMB; i++) {
        const buf = crypto.randomBytes(1 << 20)
        h.update(buf)
        fs.writeSync(fd, buf)
      }
      fs.closeSync(fd)
      const id = h.digest('hex')
      fs.renameSync(tmp, finalPath(id))
      return reply(200, { id, size: sizeMB * (1 << 20) })
    }
    if (url.pathname === '/netem') {
      const { args: a, clear } = json()
      const argv = clear ? ['qdisc', 'del', 'dev', 'eth0', 'root'] : ['qdisc', 'replace', 'dev', 'eth0', 'root', 'netem', ...String(a).split(/\s+/)]
      return execFile('tc', argv, (err, so, se) => reply(err && !clear ? 500 : 200, { out: so, err: se }))
    }
    if (url.pathname === '/corrupt') {
      corruptLeft = json().count || 1
      return reply(200, { corruptLeft })
    }
    if (url.pathname.startsWith('/stat/')) {
      return reply(200, await commands.blob_stat({ id: url.pathname.slice(6) }))
    }
    if (url.pathname === '/health') return reply(200, { name: NAME, page: !!page })
    reply(404, { error: 'unknown' })
  } catch (e) {
    reply(500, { error: String(e) })
  }
})

;(async () => {
  await new Promise(r => appServer.listen(APP_PORT, '0.0.0.0', r))
  await new Promise(r => ctrl.listen(CTRL_PORT, '0.0.0.0', r))
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  context = await browser.newContext()
  await context.addInitScript(SHIM)
  console.log(`[${NAME}] ready app=:${APP_PORT} control=:${CTRL_PORT} data=${DATA}`)
})()

process.on('SIGTERM', () => process.exit(0))
