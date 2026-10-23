/**
 * dsh-session-trash — 回收站核心服务
 *
 * 纯 Node 文件操作，不依赖 DSH 内部 API。所有路径约定来自对
 * dsh-session-persistence-jsonl 的逆向验证（见 _dsh_docs/persistence-jsonl.js）：
 *
 *   <home>/sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd
 *   <home>/storages/workspace.json      ← 会话成员关系的唯一注册表
 *   <home>/storages/session_projcache/sessions/<sessionId>.json
 *
 * 删除 = 把整个会话目录移动到 <home>/trash/<stamp>-<sessionId>/，
 * 并写 meta.json 记录原始位置。恢复就是反向移动。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SEPARATORS = new Set(['/', '\\', ':'])
const SAFE = /^[A-Za-z0-9._-]$/

/**
 * 与 dsh-session-persistence-jsonl 的 projectKey() 逐字对应。
 * 分隔符 -> '-'（连续合并），安全字符原样，其余 -> ~XXXX（大写 hex）。
 */
export function projectKey(cwd) {
  if (!cwd) throw new Error('projectKey: cwd 不能为空')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]
    if (SEPARATORS.has(ch)) {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && SAFE.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const trimmed = readable.replace(/^-+/, '') || 'root'
  return `--${trimmed.slice(0, 251)}--`
}

const exists = async (p) => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 校验来自客户端的回收站条目名。
 *
 * 条目的名字永远是我们自己生成的 `<stamp>-<sessionId>`，不含分隔符。
 * 但 restore/purge 的入参直接来自 HTTP 请求，path.join 会展开 `..`，
 * 不加限制就能用 "../../x" 越出回收站去删别的东西。
 */
const assertTrashEntryName = (name) => {
  if (typeof name !== 'string' || name.length === 0) throw new Error('回收站条目名为空')
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`非法的回收站条目名: ${name}`)
  }
  if (path.isAbsolute(name) || path.basename(name) !== name) {
    throw new Error(`非法的回收站条目名: ${name}`)
  }
  return name
}

/**
 * 找出会话目录里的日志文件名，不写死格式版本。
 *
 * 之前固定拼 session.v4.jsonl.zstd，而 SESSION_FORMAT_VERSION 是会被升的
 * （core/session/src/types.ts 里定义），升到 v5 就会静默读不到 header。
 * 这里按 session.v<N>.jsonl.<ext> 扫一遍，取版本号最大的那个。
 */
const findSessionLog = async (dir) => {
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return null
  }
  let best = null
  let bestVersion = -1
  for (const name of names) {
    const m = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/.exec(name)
    if (!m) continue
    const version = Number(m[1])
    if (version > bestVersion) {
      bestVersion = version
      best = name
    }
  }
  return best ? { file: path.join(dir, best), version: bestVersion, name: best } : null
}

export class TrashService {
  #home
  #retentionDays
  #logger
  #timer = null
  #sweeping = null
  #registry
  #hooks
  #activity

  constructor({ home, retentionDays = 7, sweepIntervalMs = 6 * 3600_000, logger, registry, hooks, activity } = {}) {
    if (!home) throw new Error('TrashService: 缺少 home')
    this.#home = home
    this.#retentionDays = retentionDays
    this.#sweepIntervalMs = sweepIntervalMs
    this.#logger = logger
    // ctx.workspaceRegistry。传入时走它的 API（会 emit 变更事件、驱动客户端刷新）；
    // 未传入时退化为直接改 workspace.json（客户端不会收到推送，需手动刷新）。
    this.#registry = registry ?? null
    // 会话列表通知钩子：{ removed(sessionId), added(sessionId) }
    // 仅靠 workspace 的 detach 不够——那只会让会话「脱离工作区」，
    // 客户端仍把它显示在「未分组」里。必须同时让它从 sessions 列表消失。
    this.#hooks = hooks ?? {}
    // 活动探针：{ probe(sessionId), stop(sessionId) }。
    // 由 Host 侧用 DSH 官方的 waterfall / parallel 事件注入，见 lib/index.js。
    this.#activity = activity ?? null
  }

  #sweepIntervalMs

  setHooks(hooks) {
    this.#hooks = { ...this.#hooks, ...(hooks ?? {}) }
  }

  /**
   * 延迟注入活动探针（Host 侧在服务就绪后调用）。
   *
   * probe(sessionId) 返回活动数组（每项带 kind：turn / job / subagent），
   * stop(sessionId) 请求停止该会话的工作。
   */
  setActivity(activity) {
    this.#activity = activity ?? null
  }

  get home() { return this.#home }
  get sessionsRoot() { return path.join(this.#home, 'sessions') }
  get trashRoot() { return path.join(this.#home, 'trash') }
  get projCacheRoot() { return path.join(this.#home, 'storages', 'session_projcache', 'sessions') }
  get registryPath() { return path.join(this.#home, 'storages', 'workspace.json') }
  get retentionDays() { return this.#retentionDays }

  /**
   * 延迟注入 workspaceRegistry（Host 侧在服务就绪后调用）。
   * 接上之后，删除/恢复会走注册表 API，客户端能收到推送并立即刷新。
   */
  setRegistry(registry) {
    this.#registry = registry ?? null
  }

  // ---------------- 注册表 ----------------

  async #readRegistry() {
    const raw = await fs.readFile(this.registryPath, 'utf8')
    return JSON.parse(raw)
  }

  async #writeRegistry(reg) {
    // 原子写：先写临时文件再替换，避免中途崩溃留下半个 JSON
    const tmp = `${this.registryPath}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(reg, null, 2), 'utf8')
    await fs.rename(tmp, this.registryPath)
  }

  /** 返回 Map<sessionId, {workspaceId, workspacePath}> */
  async #registryIndex(reg) {
    const map = new Map()
    for (const [wid, ws] of Object.entries(reg?.tables?.workspaces ?? {})) {
      for (const sid of ws?.sessionIds ?? []) {
        map.set(sid, { workspaceId: wid, workspacePath: ws.path })
      }
    }
    return map
  }

  // ---------------- 查询 ----------------

  /** 列出磁盘上所有会话目录：{ sessionId, projectKey, dir, sizeBytes, mtimeMs } */
  async listSessions() {
    const out = []
    const projectDirs = await fs.readdir(this.sessionsRoot, { withFileTypes: true }).catch(() => [])
    for (const pd of projectDirs) {
      if (!pd.isDirectory()) continue
      const pdir = path.join(this.sessionsRoot, pd.name)
      const sessionDirs = await fs.readdir(pdir, { withFileTypes: true }).catch(() => [])
      for (const sd of sessionDirs) {
        if (!sd.isDirectory()) continue
        const dir = path.join(pdir, sd.name)
        const stat = await fs.stat(dir).catch(() => null)
        out.push({
          sessionId: sd.name,
          projectKey: pd.name,
          dir,
          sizeBytes: stat?.size ?? 0,
          mtimeMs: stat?.mtimeMs ?? 0,
        })
      }
    }
    return out
  }

  /** 解析会话所在位置；注册表优先，磁盘扫描兜底 */
  async locate(sessionId) {
    if (!sessionId || !sessionId.startsWith('session-')) {
      throw new Error(`非法的 sessionId: ${sessionId}`)
    }
    const reg = await this.#readRegistry()
    const idx = await this.#registryIndex(reg)
    const known = idx.get(sessionId)

    if (known?.workspacePath) {
      const key = projectKey(known.workspacePath)
      const dir = path.join(this.sessionsRoot, key, sessionId)
      if (await exists(dir)) {
        return { sessionId, projectKey: key, dir, workspaceId: known.workspaceId, workspacePath: known.workspacePath }
      }
    }

    // 兜底：磁盘扫描
    for (const s of await this.listSessions()) {
      if (s.sessionId === sessionId) {
        return { ...s, workspaceId: known?.workspaceId ?? null, workspacePath: known?.workspacePath ?? null }
      }
    }
    return null
  }

  /** 回收站条目列表（含剩余天数、占用大小） */
  async list() {
    const items = await fs.readdir(this.trashRoot, { withFileTypes: true }).catch(() => [])
    const now = Date.now()
    const out = []
    for (const it of items) {
      if (!it.isDirectory()) continue
      const dir = path.join(this.trashRoot, it.name)
      const meta = await this.#readMeta(dir)
      if (!meta) continue
      const deletedAtMs = Date.parse(meta.deletedAt)
      const expiresAtMs = deletedAtMs + this.#retentionDays * 86400_000
      out.push({
        dir: it.name,
        ...meta,
        sizeBytes: await this.#dirSize(dir),
        deletedAtMs,
        expiresAtMs,
        remainingDays: Math.max(0, Math.ceil((expiresAtMs - now) / 86400_000)),
        expired: expiresAtMs <= now,
      })
    }
    return out.sort((a, b) => b.deletedAtMs - a.deletedAtMs)
  }

  /** 递归统计目录字节数；失败当作 0，不让统计影响列表 */
  async #dirSize(dir) {
    let total = 0
    const walk = async (d) => {
      let entries
      try {
        entries = await fs.readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.isFile()) {
          try {
            total += (await fs.stat(p)).size
          } catch {
            /* 忽略单个文件 */
          }
        }
      }
    }
    await walk(dir)
    return total
  }

  async #readMeta(dir) {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'))
    } catch {
      return null
    }
  }

  // ---------------- 变更 ----------------

  /** 把会话移入回收站。返回 meta。 */
  /**
   * 删除前预检：会话是否还有工作在跑。
   *
   * 用的是 DSH 官方的 `workspace/session-activity` waterfall —— 官方归档
   * （archiveSession）拒绝活跃会话时读的就是它，族有 turn / job / subagent。
   *
   * 注意：早先这里调的是 reg.checkArchive / ws.probeSessionActivity，
   * 这两个方法在 DSH 里并不存在（DSH 用的是事件而不是方法），于是探针恒返回
   * 「不活跃」，运行中保护形同虚设——而运行中的会话恰恰是最容易在删除后
   * 继续存活、进而掉进「未分组」的那些。
   *
   * 拿不到探针时返回 { active: false }（无法判断就不拦）。
   * 真正的兜底是删除流程里的 archiveSession：它自己会做准入检查。
   */
  async probeActive(sessionId) {
    const probe = this.#activity?.probe
    if (typeof probe !== 'function') return { active: false, families: [] }
    try {
      const list = await probe(sessionId)
      const families = Array.isArray(list)
        ? list.map((entry) => entry?.kind).filter((kind) => typeof kind === 'string')
        : []
      return { active: families.length > 0, families }
    } catch (e) {
      this.#logger?.warn?.(`dsh-session-trash: 活动探针失败: ${e.message}`)
      return { active: false, families: [] }
    }
  }

  /**
   * 请求停止会话的工作（活动探针注入的 stop）。
   *
   * 只在注册表没有归档能力时用作退路：正常路径由 archiveSession 的
   * stopActivity 选项一并完成停止。
   */
  async #stopActivity(sessionId) {
    const stop = this.#activity?.stop
    if (typeof stop !== 'function') return
    try {
      await stop(sessionId)
      this.#logger?.info?.(`dsh-session-trash: 已请求停止 ${sessionId} 的运行中工作`)
    } catch (e) {
      this.#logger?.warn?.(`dsh-session-trash: 停止运行中工作失败: ${e.message}`)
    }
  }

  /**
   * 归档会话 —— DSH 隐藏一个会话的官方机制。
   *
   * 为什么必须归档：DSH 的会话语料是「落盘 ∪ 活会话」，插件把目录移进回收站
   * 只清掉了「落盘」那一半。会话只要还活在 ctx.sessions 里（挂着 agent 的会话
   * 会一直活到它的生命周期结束），下一次拉取列表它就会回来；而插件已经把它从
   * 工作区摘掉了，于是客户端把它归到「未分组」。
   *
   * 客户端判定可见性的官方口径是 sessionVisible()：归档集合里的会话在默认
   * 过滤下不可见。所以把会话留在归档集合里，它就不会出现在任何地方。
   *
   * archiveSession 还顺带做了两件事：摘掉置顶、按需停止运行中的工作。
   * 活跃且未确认停止时它会抛 WorkspaceActiveSessionError（什么都不写），
   * 这里转成 SESSION_ACTIVE 交给界面弹「停止并删除」。
   *
   * 必须在移动目录之前调用：archiveSession 会校验会话是否已知，
   * 文件移走之后它就不「已知」了。
   */
  async #archiveForTrash(sessionId, stopActivity) {
    const reg = this.#registry
    if (typeof reg?.archiveSession !== 'function') {
      // 注册表没有归档能力：至少按官方的停止通道把工作停掉
      if (stopActivity) await this.#stopActivity(sessionId)
      this.#logger?.warn?.(
        'dsh-session-trash: 注册表不可用，无法归档；该会话在 DSH 释放它之前仍可能显示在侧栏',
      )
      return false
    }
    try {
      await reg.archiveSession(sessionId, { stopActivity: stopActivity === true })
      this.#logger?.info?.(`dsh-session-trash: 已归档 ${sessionId}（侧栏不再显示）`)
      return true
    } catch (e) {
      const activity = Array.isArray(e?.activity) ? e.activity : null
      if (activity !== null) {
        // 活跃：这是准入拒绝，什么都没写。转成 SESSION_ACTIVE 交给界面。
        const families = activity.map((entry) => entry?.kind).filter((kind) => typeof kind === 'string')
        const err = new Error(`会话仍在运行（${families.join(' / ') || '有活动'}）`)
        err.code = 'SESSION_ACTIVE'
        err.families = families
        throw err
      }
      // 其它错误（例如注册表认为这个会话未知）：归档只是「隐藏」的增强，
      // 不该因此让删除失败。退回原来的行为（只摘成员关系）。
      this.#logger?.warn?.(
        `dsh-session-trash: 归档 ${sessionId} 失败（${e.message}），退回仅摘除成员关系`,
      )
      return false
    }
  }

  /**
   * 删除会话（移入回收站）。
   *
   * @param options.stopActivity 为 true 时，对有工作的会话先请求 Host 停止再删
   *   （与内置「停止并归档」同一语义）；为 false 时若探到活跃工作会抛出
   *   SESSION_ACTIVE，由界面决定是否带 stopActivity 重试。
   */
  async moveToTrash(sessionId, { title, stopActivity = false } = {}) {
    const loc = await this.locate(sessionId)
    if (!loc) throw new Error(`找不到会话: ${sessionId}`)

    // ---- 预检：还有工作在跑就先问一句 ----
    // 这一步只决定「要不要弹停止确认」。真正的准入由下面的 archiveSession 兜底。
    const probe = await this.probeActive(sessionId)
    if (probe.active && !stopActivity) {
      const err = new Error(`会话仍在运行（${probe.families.join(' / ') || '有活动'}）`)
      err.code = 'SESSION_ACTIVE'
      err.families = probe.families
      throw err
    }

    // ---- 归档：把会话从 DSH 的可见集合里摘掉 ----
    // 必须在移动目录之前：archiveSession 会校验会话是否已知，移走之后就不「已知」了。
    // 它同时承担活动准入：活跃且未确认停止时抛 SESSION_ACTIVE（此时什么都没写）。
    const archived = await this.#archiveForTrash(sessionId, stopActivity)
    if (archived && probe.active) {
      // archiveSession 已在 stopActivity 模式下一并请求停止；这里只是记一笔。
      this.#logger?.info?.(`dsh-session-trash: ${sessionId} 归档时已请求停止运行中工作`)
    }

    // 目录名带毫秒，并且逐次避让已存在的同名目录：
    // 只精确到秒时，同一会话在同一秒内被删两次会撞名，
    // fs.rename 到已存在的目录会抛 EPERM。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
    let name = `${stamp}-${sessionId}`
    let dest = path.join(this.trashRoot, name)

    const meta = {
      sessionId,
      workspaceId: loc.workspaceId,
      workspacePath: loc.workspacePath,
      // 关键：保存编码后的 key，恢复时不重算（编码有损，重算可能落错位置）
      projectKey: loc.projectKey,
      title: title ?? (await this.#peekTitle(sessionId)) ?? '',
      deletedAt: new Date().toISOString(),
    }

    /** 把会话原样搬回原位，并撤掉已写的 meta/缓存 */
    const rollback = async () => {
      try {
        // 缓存先还回原处（如果已经挪进去了）
        const parked = path.join(dest, 'projcache.json')
        if (await exists(parked)) {
          await fs.rename(parked, path.join(this.projCacheRoot, `${sessionId}.json`)).catch(async () => {
            await fs.copyFile(parked, path.join(this.projCacheRoot, `${sessionId}.json`)).catch(() => {})
            await fs.rm(parked, { force: true }).catch(() => {})
          })
        }
        await fs.rm(path.join(dest, 'meta.json'), { force: true }).catch(() => {})
        // 会话目录搬回去
        await fs.rename(dest, loc.dir)
        this.#logger?.warn?.(`dsh-session-trash: 删除中途失败，已回滚 ${sessionId}`)
      } catch (e) {
        this.#logger?.warn?.(
          `dsh-session-trash: 回滚失败，会话仍在回收站 ${name}: ${e.message}`,
        )
      }
    }

    // 从这里开始的任何失败都要把归档撤回来：会话还在原位，
    // 就不该继续被归档集合藏着（否则它会「消失」但又没进回收站）。
    try {
      await fs.mkdir(this.trashRoot, { recursive: true })
      for (let i = 2; await exists(dest); i++) {
        name = `${stamp}-${i}-${sessionId}`
        dest = path.join(this.trashRoot, name)
      }

      // ---- 执行：目录移动是唯一不可逆的一步，之后的失败都回滚它 ----
      await fs.rename(loc.dir, dest)

      await fs.writeFile(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')

      // 投影缓存：连同会话一起移入回收站，而不是删掉。
      // 这份缓存里有标题等投影状态，删了以后恢复出来的会话会显示「未命名」，
      // 必须等用户点开它才重新计算。移走 + 还原就能保留标题。
      const cacheFile = path.join(this.projCacheRoot, `${sessionId}.json`)
      if (await exists(cacheFile)) {
        await fs.rename(cacheFile, path.join(dest, 'projcache.json')).catch(async () => {
          // 跨盘等情况退化为复制后删除
          await fs.copyFile(cacheFile, path.join(dest, 'projcache.json'))
          await fs.rm(cacheFile, { force: true })
        })
      }

      await this.#detachFromWorkspace(sessionId, loc.workspaceId)
    } catch (e) {
      // 磁盘层面的失败必须回滚，否则会话既不在原位、也没能在回收站里正常登记
      await rollback()
      // 归档也要撤回来：会话还在原位，就不该继续被归档集合藏着
      await this.#unarchive(sessionId)
      throw e
    }

    // 关键：让会话从「会话列表」里消失。
    // 只做 workspace detach 的话，客户端会把它显示在「未分组」下。
    // 归档（见 #archiveForTrash）才是让 DSH 彻底不再列出它的机制；
    // 这条通知只是让当前这一个窗口立刻把这一行去掉。
    this.#notify('removed', sessionId)

    // 带上 dir，界面据此提供「撤销」（直接调 restore）
    return { ...meta, dir: name }
  }

  /**
   * 从工作区摘除成员关系（不再 unarchive —— 会话要留在归档集合里）。
   *
   * 优先走 ctx.workspaceRegistry 的 API：它内部会 emit 变更事件，
   * 客户端的 follow() 流随即收到 remove 帧，侧栏立刻刷新。
   * 直接写 workspace.json 不会有事件，界面要等下一次无关重渲染才更新。
   */
  async #detachFromWorkspace(sessionId, workspaceId) {
    const reg = this.#registry

    if (reg) {
      // ---- 首选：注册表 API ----
      try {
        const ws = workspaceId ? reg.get?.(workspaceId) : null
        if (ws?.detachSession) {
          await ws.detachSession(sessionId)
          this.#logger?.info?.(`dsh-session-trash: 已从工作区摘除 ${sessionId}`)
        }
        // 归档集合里保留这个 id：客户端据此判定它不可见（sessionVisible）。
        // 恢复时由 #attachToRegistry 摘掉归档。
        await reg.unpinSession?.(sessionId)
        return
      } catch (e) {
        this.#logger?.warn?.(`dsh-session-trash: 注册表 API 失败，回退到文件写入: ${e.message}`)
      }
    }

    // ---- 回退：直接改文件（无事件推送）----
    try {
      const data = await this.#readRegistry()
      for (const ws of Object.values(data?.tables?.workspaces ?? {})) {
        if (Array.isArray(ws.sessionIds)) ws.sessionIds = ws.sessionIds.filter((x) => x !== sessionId)
      }
      const g = data?.global ?? {}
      // 归档集合要**写入**这个 id：客户端靠它判定会话不可见，
      // 少了它，被删的会话就会回到「未分组」。
      if (Array.isArray(g.archivedSessionIds) && !g.archivedSessionIds.includes(sessionId)) {
        g.archivedSessionIds = [...g.archivedSessionIds, sessionId]
      }
      if (Array.isArray(g.pinnedSessionIds)) {
        g.pinnedSessionIds = g.pinnedSessionIds.filter((x) => x !== sessionId)
      }
      await this.#writeRegistry(data)
      this.#logger?.warn?.('dsh-session-trash: 使用了文件回退，客户端可能需要手动刷新')
    } catch (e) {
      this.#logger?.warn?.(`dsh-session-trash: 注册表更新失败（会话已移入回收站）: ${e.message}`)
    }
  }

  /**
   * 从归档集合里摘掉一个会话（删除失败回滚、恢复会话时用）。
   */
  async #unarchive(sessionId) {
    const reg = this.#registry
    if (reg) {
      try {
        await reg.unarchiveSession?.(sessionId)
        return
      } catch (e) {
        this.#logger?.warn?.(`dsh-session-trash: 撤销归档失败: ${e.message}`)
      }
    }
    try {
      const data = await this.#readRegistry()
      const g = data?.global ?? {}
      if (Array.isArray(g.archivedSessionIds)) {
        g.archivedSessionIds = g.archivedSessionIds.filter((x) => x !== sessionId)
      }
      await this.#writeRegistry(data)
    } catch (e) {
      this.#logger?.warn?.(`dsh-session-trash: 撤销归档（文件回退）失败: ${e.message}`)
    }
  }

  /** 从投影缓存里读标题（尽力而为） */
  async #peekTitle(sessionId) {
    try {
      const raw = await fs.readFile(path.join(this.projCacheRoot, `${sessionId}.json`), 'utf8')
      return JSON.parse(raw)?.record?.rows?.title?.val ?? ''
    } catch {
      return ''
    }
  }

  /** 从回收站恢复 */
  async restore(trashDirName) {
    const dir = path.join(this.trashRoot, assertTrashEntryName(trashDirName))
    const meta = await this.#readMeta(dir)
    if (!meta) throw new Error('回收站条目缺少 meta.json')
    if (!meta.projectKey) throw new Error('meta.json 缺少 projectKey，无法确定还原位置')
    // meta 由我们自己写，但它是磁盘上的文件，同样按不可信输入校验一次
    if (typeof meta.sessionId !== 'string' || !meta.sessionId.startsWith('session-')) {
      throw new Error(`meta.json 的 sessionId 非法: ${meta.sessionId}`)
    }

    const origin = path.join(this.sessionsRoot, meta.projectKey, meta.sessionId)
    if (await exists(origin)) throw new Error(`目标位置已存在同名会话，拒绝覆盖`)

    await fs.mkdir(path.dirname(origin), { recursive: true })
    await fs.rename(dir, origin)

    // meta.json 是回收站元数据，不留在会话目录里
    const stray = path.join(origin, 'meta.json')
    if (await exists(stray)) await fs.rm(stray, { force: true })

    // 投影缓存放回原处，标题等信息立即恢复
    const parkedCache = path.join(origin, 'projcache.json')
    if (await exists(parkedCache)) {
      await fs.mkdir(this.projCacheRoot, { recursive: true })
      await fs.rename(parkedCache, path.join(this.projCacheRoot, `${meta.sessionId}.json`)).catch(async () => {
        await fs.copyFile(parkedCache, path.join(this.projCacheRoot, `${meta.sessionId}.json`))
        await fs.rm(parkedCache, { force: true })
      })
    }

    await this.#attachToRegistry(meta.sessionId, meta.workspaceId)

    // 恢复：发带完整 summary 的 api-session/added，客户端据此把这一行加回来。
    // 读头必须在会话目录已还原之后（origin 现在是正常会话目录）；
    // projections 从刚放回原处的缓存里读，这样侧栏立刻能显示标题而不是「未命名」。
    const header = await this.readSessionHeader(origin)
    const projections = await this.readListProjections(meta.sessionId)
    const summary = this.buildSummary(
      header ?? { id: meta.sessionId, cwd: meta.workspacePath },
      { projections },
    )
    this.#notify('added', meta.sessionId, summary)

    return meta
  }

  /** 调用会话列表通知钩子（失败不影响主流程） */
  #notify(kind, sessionId, extra) {
    const fn = this.#hooks?.[kind]
    if (typeof fn !== 'function') return
    try {
      fn(sessionId, extra)
    } catch (e) {
      this.#logger?.warn?.(`dsh-session-trash: ${kind} 通知失败: ${e.message}`)
    }
  }

  /**
   * 读取会话日志的 header（第一帧里就是一个 {"type":"session", ...} 记录）。
   *
   * 日志是 .jsonl.zstd，且是【多帧】压缩（每个 append 批次一帧）；
   * zstdDecompressSync 只解第一帧 —— 这恰好够用，header 就在第一帧。
   * 文件名按版本号探测，不写死 v4。
   */
  async readSessionHeader(sessionDir) {
    try {
      const log = await findSessionLog(sessionDir)
      if (!log) {
        this.#logger?.warn?.('dsh-session-trash: 会话目录里找不到日志文件')
        return null
      }
      const buf = await fs.readFile(log.file)
      // 未压缩的 .jsonl 直接用，压缩的才解 zstd
      const text = log.name.endsWith('.zstd')
        ? zlib.zstdDecompressSync(buf).toString('utf8')
        : buf.toString('utf8')
      const firstLine = text.split('\n').find((l) => l.trim())
      if (!firstLine) return null
      const rec = JSON.parse(firstLine)
      return rec.type === 'session' ? rec : null
    } catch (e) {
      this.#logger?.warn?.(`dsh-session-trash: 读会话头失败: ${e.message}`)
      return null
    }
  }

  /**
   * 从投影缓存读取列表页需要的投影值。
   *
   * 缓存结构：{ version, record: { identity, rows } }
   * rows[key] = { ver, seq, val } —— 客户端要的是 val 本身。
   */
  async readListProjections(sessionId) {
    try {
      const file = path.join(this.projCacheRoot, `${sessionId}.json`)
      const raw = JSON.parse(await fs.readFile(file, 'utf8'))
      const rows = raw?.record?.rows ?? {}
      const values = {}
      // title 决定侧栏显示的名字；少了它就是「未命名」
      if (rows.title && rows.title.val != null && rows.title.val !== '') {
        values.title = rows.title.val
      }
      if (rows.sessionListMetadata?.val) {
        values.sessionListMetadata = rows.sessionListMetadata.val
      }
      return Object.keys(values).length ? values : null
    } catch {
      return null
    }
  }

  /**
   * 构造一条 api-session/added 需要的 summary。
   *
   * 字段对照 dsh-api-session-controller 的 summaryFor()：
   *   sessionId / updatedAt / agentAvailable / formatStatus / running / blank / cwd
   *
   * 另外必须带 projections —— 客户端 handleSessionAdded 里：
   *   if (summary.projections !== void 0) applyListBlock(...)
   * 没有它，标题不会被应用，侧栏就显示「未命名」。
   * 这里用 kind:'cached'：值来自持久化检查点，正是我们回收站里存的那份。
   */
  buildSummary(header, { projections } = {}) {
    if (!header?.id) return null
    const meta = projections?.sessionListMetadata
    const out = {
      sessionId: header.id,
      updatedAt: Math.max(header.createdAt ?? 0, meta?.lastPromptAt ?? 0) || Date.now(),
      agentAvailable: false,
      formatStatus: 'current',
      running: false,
      blank: meta?.blank ?? false,
    }
    if (header.cwd !== undefined) out.cwd = header.cwd
    if (header.parentSession !== undefined) out.parentSessionId = header.parentSession
    if (header.origin !== undefined) out.origin = header.origin
    if (projections) out.projections = { kind: 'cached', values: projections }
    return out
  }

  /**
   * 把会话重新挂回注册表。同样优先走 API 以获得事件推送。
   *
   * 恢复时必须撤销归档：会话在回收站期间一直留在归档集合里（那是让它
   * 不出现在侧栏的机制），不撤掉的话会话回来了却还是不可见的。
   */
  async #attachToRegistry(sessionId, workspaceId) {
    const reg = this.#registry

    if (reg) {
      try {
        const ws = workspaceId ? reg.get?.(workspaceId) : null
        if (ws?.attachSession) {
          await ws.attachSession(sessionId)
          // 撤销归档：会话回到了磁盘和侧栏，就不该再被归档集合藏着
          await reg.unarchiveSession?.(sessionId)
          this.#logger?.info?.(`dsh-session-trash: 已挂回工作区 ${sessionId}`)
          return
        }
        if (!ws) {
          this.#logger?.warn?.(`dsh-session-trash: 工作区 ${workspaceId} 已不存在，会话已还原但未登记`)
          await reg.unarchiveSession?.(sessionId)
          return
        }
      } catch (e) {
        this.#logger?.warn?.(`dsh-session-trash: 注册表 API 失败，回退到文件写入: ${e.message}`)
      }
    }

    try {
      const data = await this.#readRegistry()
      const ws = data?.tables?.workspaces?.[workspaceId]
      if (ws) {
        if (!Array.isArray(ws.sessionIds)) ws.sessionIds = []
        if (!ws.sessionIds.includes(sessionId)) ws.sessionIds.push(sessionId)
      } else {
        this.#logger?.warn?.(`dsh-session-trash: 工作区 ${workspaceId} 已不存在，会话已还原但未登记`)
      }
      const g = data?.global ?? {}
      if (Array.isArray(g.archivedSessionIds)) {
        g.archivedSessionIds = g.archivedSessionIds.filter((x) => x !== sessionId)
      }
      await this.#writeRegistry(data)
    } catch (e) {
      this.#logger?.warn?.(`dsh-session-trash: 注册表恢复失败: ${e.message}`)
    }
  }

  /** 立即彻底删除某条目 */
  async purge(trashDirName) {
    const name = assertTrashEntryName(trashDirName)
    const dir = path.join(this.trashRoot, name)
    if (!(await exists(dir))) throw new Error('条目不存在')
    // 双保险：解析后的绝对路径必须仍在回收站根之内
    const root = path.resolve(this.trashRoot)
    if (path.resolve(dir) !== path.join(root, name)) throw new Error(`非法的回收站条目名: ${name}`)
    await fs.rm(dir, { recursive: true, force: true })
    // 会话彻底没了，归档集合里那个 id 也不能留着
    const meta = await this.#readMeta(dir).catch(() => null)
    if (meta?.sessionId) await this.#unarchive(meta.sessionId)
  }

  /** 清空全部 */
  async purgeAll() {
    const items = await this.list()
    for (const it of items) await this.purge(it.dir)
    return items.length
  }

  /** 清理过期条目 */
  async sweep() {
    if (this.#sweeping) return this.#sweeping
    this.#sweeping = (async () => {
      try {
        const items = await this.list()
        const expired = items.filter((i) => i.expired)
        for (const it of expired) {
          const dir = path.join(this.trashRoot, it.dir)
          const meta = await this.#readMeta(dir).catch(() => null)
          await fs.rm(dir, { recursive: true, force: true })
          // 过期清理同样要撤掉归档标记
          if (meta?.sessionId) await this.#unarchive(meta.sessionId)
        }
        if (expired.length) {
          this.#logger?.info?.(`dsh-session-trash: 已清理 ${expired.length} 个过期会话`)
        }
        return expired.length
      } finally {
        this.#sweeping = null
      }
    })()
    return this.#sweeping
  }

  /** 启动定时清理 */
  startSweeper() {
    if (this.#timer) return
    void this.sweep().catch((e) => this.#logger?.warn?.(`dsh-session-trash: 首次清理失败: ${e.message}`))
    this.#timer = setInterval(() => {
      void this.sweep().catch((e) => this.#logger?.warn?.(`dsh-session-trash: 定时清理失败: ${e.message}`))
    }, this.#sweepIntervalMs)
    if (typeof this.#timer.unref === 'function') this.#timer.unref()
  }

  stopSweeper() {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }
}
