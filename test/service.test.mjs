import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { TrashService, projectKey } from '../lib/trash-service.js'

const log = { info() {}, warn() {}, error() {} }
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

// ---------- projectKey ----------

await t('projectKey 与 DSH 编码规则一致（含中文路径）', () => {
  // 期望值按 DSH 源码 projectKey() 推导：分隔符合并成一个 '-'，
  // 非安全字符编成 ~XXXX 大写十六进制。用中文覆盖该分支。
  assert.equal(projectKey('D:\\demo\\日常'), '--D-demo-~65E5~5E38--')
})

await t('projectKey 合并连续分隔符', () => {
  assert.equal(projectKey('C:\\Users\\someone'), '--C-Users-someone--')
})

await t('projectKey 保留安全字符', () => {
  assert.equal(projectKey('D:\\a-b'), '--D-a-b--')
})

await t('projectKey 单连字符与分隔符有损等价（已知限制）', () => {
  assert.equal(projectKey('D:\\a-b\\c'), projectKey('D:\\a\\b\\c'))
})

// ---------- 服务 ----------

const home = path.join(process.cwd(), '_scratch', 'trash-service-test')
await fs.rm(home, { recursive: true, force: true })

const WS_ID = 'ws-1'
const WS_PATH = 'D:\\demo\\proj'
const KEY = projectKey(WS_PATH)

async function seed(sessionIds) {
  await fs.mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  const dir = path.join(home, 'sessions', KEY)
  await fs.mkdir(dir, { recursive: true })
  for (const sid of sessionIds) {
    const sd = path.join(dir, sid)
    await fs.mkdir(sd, { recursive: true })
    await fs.writeFile(path.join(sd, 'session.v4.jsonl.zstd'), `payload-${sid}`)
    await fs.writeFile(
      path.join(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`),
      JSON.stringify({ version: 7, record: { rows: { title: { val: `标题-${sid}` } } } }),
    )
  }
  await fs.writeFile(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, archivedSessionIds: [sessionIds[1]], pinnedSessionIds: [sessionIds[0]] },
      tables: { workspaces: { [WS_ID]: { path: WS_PATH, title: 'proj', sessionIds: [...sessionIds] } } },
    }),
  )
}

const S1 = 'session-aaaa'
const S2 = 'session-bbbb'

await t('seed 两个会话', async () => {
  await seed([S1, S2])
  const svc = new TrashService({ home, logger: log })
  const list = await svc.listSessions()
  assert.equal(list.length, 2)
})

await t('locate 通过注册表定位', async () => {
  const svc = new TrashService({ home, logger: log })
  const loc = await svc.locate(S1)
  assert.equal(loc.projectKey, KEY)
  assert.equal(loc.workspaceId, WS_ID)
})

await t('moveToTrash 移动目录并写 meta', async () => {
  const svc = new TrashService({ home, logger: log })
  const meta = await svc.moveToTrash(S1)
  assert.equal(meta.sessionId, S1)
  assert.equal(meta.projectKey, KEY)
  assert.equal(meta.title, `标题-${S1}`)
  assert.equal(await svc.locate(S1), null, '移走后应定位不到')
})

await t('moveToTrash 把投影缓存移出原位置', async () => {
  // 注意：不是删除，而是搬进回收站，这样恢复后标题才在。
  const f = path.join(home, 'storages', 'session_projcache', 'sessions', `${S1}.json`)
  await assert.rejects(fs.access(f), '原位置应已移走')
})

await t('moveToTrash 从注册表移除成员/归档/置顶', async () => {
  const reg = JSON.parse(await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
  const ws = reg.tables.workspaces[WS_ID]
  assert.ok(!ws.sessionIds.includes(S1), '成员关系应移除')
  assert.ok(ws.sessionIds.includes(S2), '其他会话应保留')
  // S1 原在 pinnedSessionIds，S2 原在 archivedSessionIds
  assert.ok(!reg.global.pinnedSessionIds.includes(S1), '置顶应移除')
  assert.ok(!reg.global.archivedSessionIds.includes(S1), '归档集合不含 S1')
  assert.ok(reg.global.archivedSessionIds.includes(S2), 'S2 的归档状态不受影响')
})

await t('list 返回条目与剩余天数', async () => {
  const svc = new TrashService({ home, logger: log })
  const items = await svc.list()
  assert.equal(items.length, 1)
  assert.equal(items[0].sessionId, S1)
  assert.equal(items[0].remainingDays, 7)
  assert.equal(items[0].expired, false)
})

await t('restore 还原目录、清 meta、恢复注册表', async () => {
  const svc = new TrashService({ home, logger: log })
  const items = await svc.list()
  await svc.restore(items[0].dir)

  const back = path.join(home, 'sessions', KEY, S1, 'session.v4.jsonl.zstd')
  assert.equal(await fs.readFile(back, 'utf8'), `payload-${S1}`)
  assert.equal(await svc.list().then((x) => x.length), 0)

  const reg = JSON.parse(await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
  assert.ok(reg.tables.workspaces[WS_ID].sessionIds.includes(S1), '应恢复成员关系')
})

await t('restore 不把 meta.json 留在会话目录', async () => {
  const stray = path.join(home, 'sessions', KEY, S1, 'meta.json')
  await assert.rejects(fs.access(stray))
})

await t('restore 目标已存在时拒绝覆盖', async () => {
  const svc = new TrashService({ home, logger: log })
  const meta = await svc.moveToTrash(S2)
  // 手工在目标位置放一份，制造冲突
  const origin = path.join(home, 'sessions', KEY, S2)
  await fs.mkdir(origin, { recursive: true })
  const dirS2 = (await svc.list()).find((x) => x.sessionId === S2).dir
  await assert.rejects(svc.restore(dirS2), /拒绝覆盖/)
})

await t('恢复时用会话头构造 summary 并通过 added 钩子发出', async () => {
  // 造一个带真实 zstd 头的会话
  const zlib = await import('node:zlib')
  const id = 'session-hdr001'
  const sdir = path.join(home, 'sessions', KEY, id)
  await fs.mkdir(sdir, { recursive: true })
  const header = { type: 'session', version: 4, id, createdAt: 1791638317555, cwd: WS_PATH }
  await fs.writeFile(
    path.join(sdir, 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')),
  )
  await fs.writeFile(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: { [WS_ID]: { path: WS_PATH, title: 'proj', sessionIds: [id] } } },
    }),
  )

  const added = []
  const svc = new TrashService({ home, logger: log })
  svc.setHooks({ removed() {}, added: (sid, summary) => added.push({ sid, summary }) })

  const meta = await svc.moveToTrash(id)
  await svc.restore((await svc.list()).find((x) => x.sessionId === id).dir)

  assert.equal(added.length, 1, '应发出一次 added')
  assert.equal(added[0].sid, id)
  assert.ok(added[0].summary, '必须携带 summary')
  assert.equal(added[0].summary.sessionId, id)
  assert.equal(added[0].summary.cwd, WS_PATH, 'summary 应带上 cwd')
  assert.equal(added[0].summary.updatedAt, 1791638317555, 'updatedAt 取自 header.createdAt')
})

await t('恢复的 summary 携带 title 投影（否则侧栏显示未命名）', async () => {
  const zlib = await import('node:zlib')
  const id = 'session-titl01'
  const sdir = path.join(home, 'sessions', KEY, id)
  await fs.mkdir(sdir, { recursive: true })
  await fs.writeFile(
    path.join(sdir, 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(
      Buffer.from(JSON.stringify({ type: 'session', version: 4, id, createdAt: 1791000000000, cwd: WS_PATH }) + '\n'),
    ),
  )
  // 投影缓存里存标题
  await fs.writeFile(
    path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
    JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1791000000000, cwd: WS_PATH, isSeeded: false, inheritedEventCount: 0 },
        rows: {
          title: { ver: 1, seq: 5, val: '我的测试会话' },
          sessionListMetadata: { ver: 1, seq: 5, val: { blank: false, lastPromptAt: 1791000009999 } },
        },
      },
    }),
  )
  await fs.writeFile(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: { [WS_ID]: { path: WS_PATH, title: 'proj', sessionIds: [id] } } },
    }),
  )

  const added = []
  const svc = new TrashService({ home, logger: log })
  svc.setHooks({ removed() {}, added: (sid, summary) => added.push({ sid, summary }) })

  const meta = await svc.moveToTrash(id)
  await svc.restore((await svc.list()).find((x) => x.sessionId === id).dir)

  const s = added[0]?.summary
  assert.ok(s?.projections, 'summary 必须带 projections，否则客户端不应用标题')
  assert.equal(s.projections.kind, 'cached')
  assert.equal(s.projections.values.title, '我的测试会话', '标题应出现在 projections.values.title')
  assert.equal(s.updatedAt, 1791000009999, 'updatedAt 应取 lastPromptAt')
})

await t('readSessionHeader 能读出 zstd 首帧的 header', async () => {
  const svc = new TrashService({ home, logger: log })
  const h = await svc.readSessionHeader(path.join(home, 'sessions', KEY, 'session-hdr001'))
  assert.equal(h?.id, 'session-hdr001')
  assert.equal(h?.cwd, WS_PATH)
})

await t('sweep 清理过期条目', async () => {
  const svc = new TrashService({ home, logger: log, retentionDays: 7 })
  // 直接改 meta 的 deletedAt 到 8 天前
  const items = await svc.list()
  const dir = path.join(home, 'trash', items[0].dir)
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'))
  meta.deletedAt = new Date(Date.now() - 8 * 86400_000).toISOString()
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta))

  const listed = await svc.list()
  assert.equal(listed[0].expired, true)

  const n = await svc.sweep()
  assert.equal(n, 1)
  assert.equal((await svc.list()).length, 0)
})

await t('purge 立即删除', async () => {
  const svc = new TrashService({ home, logger: log })
  await svc.moveToTrash(S1)
  const items = await svc.list()
  await svc.purge(items[0].dir)
  assert.equal((await svc.list()).length, 0)
})

await t('非法 sessionId 被拒绝', async () => {
  const svc = new TrashService({ home, logger: log })
  await assert.rejects(svc.locate('../../etc/passwd'), /非法/)
})

// ---------- 路径遍历防护（P0）----------

await t('purge 拒绝路径穿越', async () => {
  const svc = new TrashService({ home, logger: log })
  for (const bad of ['../../etc', '..', 'a/b', 'C:\\Windows', '/abs/path']) {
    await assert.rejects(svc.purge(bad), /非法|条目不存在/, `应拒绝: ${bad}`)
  }
})

await t('restore 拒绝路径穿越', async () => {
  const svc = new TrashService({ home, logger: log })
  for (const bad of ['../../etc', '..', 'a/b']) {
    await assert.rejects(svc.restore(bad), /非法/, `应拒绝: ${bad}`)
  }
})

await t('restore 校验 meta 里的 sessionId', async () => {
  const svc = new TrashService({ home, logger: log })
  const dir = path.join(home, 'trash', 'evil-meta')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({ sessionId: '../../etc/passwd', projectKey: KEY, deletedAt: new Date().toISOString() }),
  )
  await assert.rejects(svc.restore('evil-meta'), /sessionId 非法/)
  await fs.rm(dir, { recursive: true, force: true })
})

// ---------- 格式版本探测（P1）----------

await t('readSessionHeader 能识别非 v4 的日志文件名', async () => {
  const zlib = await import('node:zlib')
  const id = 'session-v5test'
  const sdir = path.join(home, 'sessions', KEY, id)
  await fs.mkdir(sdir, { recursive: true })
  // 故意用 v9，模拟 DSH 升级格式版本
  await fs.writeFile(
    path.join(sdir, 'session.v9.jsonl.zstd'),
    zlib.zstdCompressSync(
      Buffer.from(JSON.stringify({ type: 'session', version: 9, id, createdAt: 1, cwd: WS_PATH }) + '\n'),
    ),
  )
  const svc = new TrashService({ home, logger: log })
  const h = await svc.readSessionHeader(sdir)
  assert.equal(h?.id, id, '应能读到 v9 日志的 header')
  await fs.rm(sdir, { recursive: true, force: true })
})

await t('readSessionHeader 支持未压缩的 .jsonl', async () => {
  const id = 'session-plain'
  const sdir = path.join(home, 'sessions', KEY, id)
  await fs.mkdir(sdir, { recursive: true })
  await fs.writeFile(
    path.join(sdir, 'session.v4.jsonl'),
    JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd: WS_PATH }) + '\n',
  )
  const svc = new TrashService({ home, logger: log })
  const h = await svc.readSessionHeader(sdir)
  assert.equal(h?.id, id)
  await fs.rm(sdir, { recursive: true, force: true })
})

// ---------- 运行中会话防护（P1）----------

await t('会话仍在运行时 moveToTrash 抛 SESSION_ACTIVE', async () => {
  await seed([S1])
  const svc = new TrashService({ home, logger: log })
  svc.setRegistry({
    get: () => ({}),
    checkArchive: async () => ({ active: true, families: ['turn', 'job'] }),
  })
  await assert.rejects(svc.moveToTrash(S1), (e) => {
    assert.equal(e.code, 'SESSION_ACTIVE')
    assert.deepEqual(e.families, ['turn', 'job'])
    return true
  })
  // 会话应仍在原位
  assert.ok(await fs.stat(path.join(home, 'sessions', KEY, S1)).catch(() => null))
})

await t('带 stopActivity 时会先停止再删除', async () => {
  await seed([S1])
  const calls = []
  const svc = new TrashService({ home, logger: log })
  svc.setRegistry({
    get: () => ({}),
    checkArchive: async () => ({ active: true, families: ['turn'] }),
    stopSessionActivity: async (id) => calls.push(['stop', id]),
  })
  await svc.moveToTrash(S1, { stopActivity: true })
  assert.deepEqual(calls, [['stop', S1]], '应先请求停止')
  assert.equal(await svc.locate(S1).catch(() => null), null, '会话应已移走')
})

// ---------- 大小统计（P2）----------

await t('list 返回 sizeBytes', async () => {
  const svc = new TrashService({ home, logger: log })
  const items = await svc.list()
  assert.ok(items.length > 0, '前置：应有条目')
  for (const it of items) {
    assert.equal(typeof it.sizeBytes, 'number')
    assert.ok(it.sizeBytes >= 0)
  }
})

await t('moveToTrash 返回 dir 供撤销使用', async () => {
  await seed([S2])
  const svc = new TrashService({ home, logger: log })
  const meta = await svc.moveToTrash(S2)
  assert.ok(meta.dir, '应返回 dir')
  assert.ok(meta.dir.includes(S2))
  await svc.restore(meta.dir)
})



await t('删除时投影缓存被移入回收站，而不是删除', async () => {
  await seed([S1])
  const svc = new TrashService({ home, logger: log })
  await svc.moveToTrash(S1)

  const cacheLeft = path.join(home, 'storages', 'session_projcache', 'sessions', `${S1}.json`)
  await assert.rejects(fs.access(cacheLeft), '原位置不应再有缓存')

  const item = (await svc.list())[0]
  const parked = path.join(home, 'trash', item.dir, 'projcache.json')
  const raw = JSON.parse(await fs.readFile(parked, 'utf8'))
  assert.equal(raw.record.rows.title.val, `标题-${S1}`, '回收站里应保留原缓存')
})

await t('恢复时投影缓存被放回原处（标题立即可用）', async () => {
  const svc = new TrashService({ home, logger: log })
  const item = (await svc.list())[0]
  await svc.restore(item.dir)

  const cacheBack = path.join(home, 'storages', 'session_projcache', 'sessions', `${S1}.json`)
  const raw = JSON.parse(await fs.readFile(cacheBack, 'utf8'))
  assert.equal(raw.record.rows.title.val, `标题-${S1}`, '恢复后标题应仍在')

  // 且不该残留在会话目录里
  const stray = path.join(home, 'sessions', KEY, S1, 'projcache.json')
  await assert.rejects(fs.access(stray), 'projcache.json 不应留在会话目录')
})

await fs.rm(home, { recursive: true, force: true })


// ---------- 注册表 API 路径（客户端即时刷新的关键）----------

await t('接入 registry 后，删除走 API 而不是写文件', async () => {
  const calls = []
  const fakeRegistry = {
    get(id) {
      return {
        async detachSession(sid) {
          calls.push(['detachSession', sid])
        },
        async attachSession(sid) {
          calls.push(['attachSession', sid])
        },
      }
    },
    async unarchiveSession(sid) {
      calls.push(['unarchiveSession', sid])
    },
    async unpinSession(sid) {
      calls.push(['unpinSession', sid])
    },
  }

  // 重新造一份数据
  await seed([S1, S2])
  const svc = new TrashService({ home, logger: log })
  svc.setRegistry(fakeRegistry)

  // 记录写文件行为：接上 registry 后不应再写 workspace.json
  const before = await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8')
  await svc.moveToTrash(S1)
  const after = await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8')

  assert.ok(
    calls.some(([m, s]) => m === 'detachSession' && s === S1),
    '应调用 detachSession',
  )
  assert.ok(calls.some(([m]) => m === 'unarchiveSession'), '应调用 unarchiveSession')
  assert.ok(calls.some(([m]) => m === 'unpinSession'), '应调用 unpinSession')
  assert.equal(before, after, '不应再直接写 workspace.json')
})

await t('恢复时走 attachSession', async () => {
  const calls = []
  const fakeRegistry = {
    get() {
      return {
        async attachSession(sid) {
          calls.push(['attachSession', sid])
        },
        async detachSession() {},
      }
    },
    async unarchiveSession() {},
    async unpinSession() {},
  }

  const svc = new TrashService({ home, logger: log })
  svc.setRegistry(fakeRegistry)
  const items = await svc.list()
  const restoring = items[0]
  await svc.restore(restoring.dir)

  // 断言：调用了 attachSession，且参数正是被恢复的那个会话
  assert.ok(
    calls.some(([m, s]) => m === 'attachSession' && s === restoring.sessionId),
    `应调用 attachSession(${restoring.sessionId})，实际: ${JSON.stringify(calls)}`,
  )
})

await t('registry API 抛错时回退到文件写入', async () => {
  const fakeRegistry = {
    get() {
      return {
        async detachSession() {
          throw new Error('boom')
        },
      }
    },
    async unarchiveSession() {},
    async unpinSession() {},
  }

  await seed([S1])
  const svc = new TrashService({ home, logger: log })
  svc.setRegistry(fakeRegistry)

  await svc.moveToTrash(S1)
  const reg = JSON.parse(await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
  assert.ok(
    !reg.tables.workspaces[WS_ID].sessionIds.includes(S1),
    '回退路径应仍把会话移出注册表',
  )
})



await t('purgeAll 清空整个回收站', async () => {
  const svc = new TrashService({ home, logger: log })
  // 先清空，避免前面的用例留下的条目干扰计数
  await svc.purgeAll()
  await seed([S1, S2])
  await svc.moveToTrash(S1)
  await svc.moveToTrash(S2)
  assert.equal((await svc.list()).length, 2, '前置：应有 2 条')

  const n = await svc.purgeAll()
  assert.equal(n, 2, '应返回删除条数')
  assert.equal((await svc.list()).length, 0, '回收站应清空')

  const left = await fs.readdir(path.join(home, 'trash')).catch(() => [])
  assert.equal(left.length, 0, 'trash 目录不应残留条目')
})

await t('空回收站上 purgeAll 返回 0', async () => {
  const svc = new TrashService({ home, logger: log })
  assert.equal(await svc.purgeAll(), 0)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)


