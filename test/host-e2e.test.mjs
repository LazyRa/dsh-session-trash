/**
 * Host 路由端到端测试。
 *
 * 模拟 DSH 的 connection.registerFetchRoute：收集注册的精确路由，
 * 用一个 dispatch 函数复刻 Connection 的分发规则，验证真实 HTTP 往返。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { apply } from '../lib/index.js'

let pass = 0
let fail = 0
async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ok   ${name}`)
  } catch (e) {
    fail++
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

const home = path.join(process.cwd(), '_scratch', 'e2e-home')
await fs.rm(home, { recursive: true, force: true })

const KEY = '--D-demo-proj--'
const S1 = 'session-1111'
const S2 = 'session-2222'

await fs.mkdir(path.join(home, 'sessions', KEY, S1), { recursive: true })
await fs.mkdir(path.join(home, 'sessions', KEY, S2), { recursive: true })
await fs.writeFile(path.join(home, 'sessions', KEY, S1, 'session.v4.jsonl.zstd'), 'data-1')
await fs.writeFile(path.join(home, 'sessions', KEY, S2, 'session.v4.jsonl.zstd'), 'data-2')
await fs.mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
await fs.writeFile(
  path.join(home, 'storages', 'session_projcache', 'sessions', `${S1}.json`),
  JSON.stringify({ version: 7, record: { rows: { title: { val: '演示会话' } } } }),
)
await fs.writeFile(
  path.join(home, 'storages', 'workspace.json'),
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { 'ws-demo': { path: 'D:\\demo\\proj', title: 'proj', sessionIds: [S1, S2] } } },
  }),
)

// ---------- 假 Cordis ctx（模拟 connection 的精确路由表）----------

const fetchRoutes = new Map()
const effects = []
const logs = []

// 逐条复刻 packages/client/connection/src/rpc-host.ts 的校验规则：
//   ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
//   assertFetchRoute(): endpointFromPath 必须有效、methods 非空且不重复
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const API_PATH = '/api'

function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (
    segments.some(
      (s) => s === '' || s === '.' || s === '..' || !ENDPOINT_SEGMENT_PATTERN.test(s),
    )
  ) {
    return undefined
  }
  return endpoint
}

function assertFetchRoute(route) {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (!Array.isArray(route.methods) || route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  if (new Set(route.methods).size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
  // 源码里 registerFetchRoute 会把 requestBody 收进 Set 并交给 bridge，
  // 只有 buffered / streaming 两种；缺失会让 bridge 走错分支，这里一并对齐。
  if (!['buffered', 'streaming'].includes(route.requestBody)) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} has invalid requestBody`)
  }
}

const connectionService = {
  // 真实的公开 API 形状：connection.fetch.register(route)
  fetch: {
    register(route) {
      assertFetchRoute(route)
      if (fetchRoutes.has(route.path)) throw new Error('duplicate route')
      fetchRoutes.set(route.path, route)
      return () => fetchRoutes.delete(route.path)
    },
  },
}

const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) },
  set() {},
  effect(fn) {
    const d = fn()
    effects.push(d)
    return d
  },
  get: (n) => (n === 'connection' ? connectionService : undefined),
  inject(deps, cb) {
    cb({ get: (n) => ctx.get(n), effect: (f) => ctx.effect(f) })
  },
}

apply(ctx, { home, retentionDays: 7, sweepIntervalMs: 3600_000 })

// ---------- 模拟 createSharedFetchHandler ----------

const dispatch = (req) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  const route = fetchRoutes.get(pathname)
  // 复刻真实行为：未注册 → 404 "not found"
  if (!route || !route.methods.includes(req.method)) return new Response('not found', { status: 404 })
  return route.fetch(req)
}

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const response = await dispatch(
    new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    }),
  )
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(await response.text())
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}/api/dsh-session-trash`

const call = async (action, body) => {
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return res.json()
}

// ---------- 用例 ----------

await t('注册了 8 条精确路由（含 probe 与 ping）', () => {
  assert.equal(fetchRoutes.size, 8, `实际 ${[...fetchRoutes.keys()].join(',')}`)
})

await t('全部路由都在 /api/ 下', () => {
  for (const p of fetchRoutes.keys()) assert.ok(p.startsWith('/api/'), p)
})

await t('list 返回结构化 JSON', async () => {
  const r = await call('list')
  assert.equal(r.ok, true)
  assert.deepEqual(r.value.items, [])
  assert.equal(r.value.retentionDays, 7)
})

await t('move 移动会话', async () => {
  const r = await call('move', { sessionId: S1 })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.value.title, '演示会话')
  assert.equal(r.value.projectKey, KEY)
})

await t('move 后目录消失、回收站出现', async () => {
  await assert.rejects(fs.access(path.join(home, 'sessions', KEY, S1)))
  assert.equal((await call('list')).value.items.length, 1)
})

await t('list 报告剩余天数', async () => {
  const it = (await call('list')).value.items[0]
  assert.equal(it.remainingDays, 7)
  assert.equal(it.expired, false)
})

await t('restore 还原', async () => {
  const dir = (await call('list')).value.items[0].dir
  const r = await call('restore', { dir })
  assert.equal(r.ok, true, r.error)
  assert.equal(await fs.readFile(path.join(home, 'sessions', KEY, S1, 'session.v4.jsonl.zstd'), 'utf8'), 'data-1')
})

await t('restore 后注册表成员关系恢复', async () => {
  const reg = JSON.parse(await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
  assert.ok(reg.tables.workspaces['ws-demo'].sessionIds.includes(S1))
})

await t('purge 彻底删除', async () => {
  await call('move', { sessionId: S2 })
  const dir = (await call('list')).value.items[0].dir
  assert.equal((await call('purge', { dir })).ok, true)
  assert.equal((await call('list')).value.items.length, 0)
})

await t('move 不存在的会话返回 ok:false', async () => {
  const r = await call('move', { sessionId: 'session-nope' })
  assert.equal(r.ok, false)
  assert.match(r.error, /找不到会话/)
})

await t('未注册路径返回 404 not found（复刻真实行为）', async () => {
  const res = await fetch(`${base}/nonexistent`)
  assert.equal(res.status, 404)
  assert.equal(await res.text(), 'not found')
})

await t('多出的路径段不会命中（证明必须精确匹配）', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/dsh-session-trash/list/extra`)
  assert.equal(res.status, 404)
})

await t('恶意 sessionId 被拒绝', async () => {
  const r = await call('move', { sessionId: '../../etc' })
  assert.equal(r.ok, false)
  assert.match(r.error, /非法/)
})

await t('ping 可用（用于确认 Host 半侧已加载）', async () => {
  const r = await call('ping')
  assert.equal(r.ok, true)
  assert.equal(r.value.pong, true)
})

await t('GET 方法不被接受（路由只声明 POST）', async () => {
  const res = await fetch(`${base}/list`, { method: 'GET' })
  assert.equal(res.status, 404)
})

server.close()
for (const d of effects) typeof d === 'function' && d()
await fs.rm(home, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

