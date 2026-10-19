/**
 * dsh-session-trash — Host 半侧
 *
 * 路由说明（实测确认）：
 *   DSH 的 `/api` 由 client-connection 独占，走【精确 Fetch 路由表】。
 *   正确定册方式是从 connection 服务上取 `fetch.register`：
 *
 *     ctx.inject(['connection'], (c) => {
 *       c.get('connection').fetch.register({ path, methods, requestBody, fetch })
 *     })
 *
 *   注意：不是 ctx.webServer.register（那是 webServer 的路由表，收不到 /api），
 *   也不是 connection.registerFetchRoute（内部方法，签名不同）。
 */

import path from 'node:path'
import { TrashService } from './trash-service.js'

export const name = 'dsh-session-trash'
export const inject = ['connection']

const PREFIX = '/api/dsh-session-trash'

export function apply(ctx, config = {}) {
  const retentionDays = Number(config.retentionDays ?? 7)
  const sweepIntervalMs = Number(config.sweepIntervalMs ?? 6 * 3600_000)

  const home =
    config.home ||
    process.env.DSH_HOME ||
    path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')

  // 统一走宿主 logger；只有连 logger 都没有时（独立测试）才退回 console。
  const logger = {
    info: (...a) => (ctx.logger?.info ? ctx.logger.info(...a) : console.log('[session-trash]', ...a)),
    warn: (...a) => (ctx.logger?.warn ? ctx.logger.warn(...a) : console.warn('[session-trash]', ...a)),
  }

  logger.info('apply() 已执行')

  const service = new TrashService({ home, retentionDays, sweepIntervalMs, logger })
  // 注意：不要用 ctx.set() 暴露服务——Cordis 要求在 provide 中先声明，
  // 否则会抛 "cannot set property without provide" 导致整个插件激活失败。
  // 插件的其它部分（路由、定时器）都通过闭包使用 service，无需对外暴露。

  // ---- 会话列表通知 ----
  //
  // 官方链路（dsh-api-session-controller）：
  //   session/created  -> api-session/added   (summary)
  //   session/disposed -> api-session/removed (id)
  //
  // 客户端 ClientSessions 分别用 handleSessionAdded(summary) /
  // handleSessionRemoved(id) 处理。
  //
  // 删除：直接发 removed 即可（只需 id），客户端本地移除那一行，立即生效。
  // 恢复：必须发【带完整 summary 的 added】。不能改用客户端 sessions.refresh()，
  //       因为 refresh 会整体重拉列表，与 removed 写入的本地移除标记冲突，
  //       表现就是已永久删除的会话被重新拉出来（掉进「未分组」）。
  service.setHooks({
    removed: (sessionId) => {
      ctx.emit('api-session/removed', sessionId)
      logger.info(`已通知移除: ${sessionId}`)
    },
    added: (sessionId, summary) => {
      if (!summary) {
        logger.warn(`恢复 ${sessionId} 但无 summary，跳过 added`)
        return
      }
      ctx.emit('api-session/added', summary)
      logger.info(`已通知新增: ${sessionId}`)
    },
  })

  // workspaceRegistry 是软依赖：有就接上（删除后推送刷新），没有就退化为直接写文件。
  // 不能放进顶层 inject —— 顶层声明了不存在的服务会让整个 apply 不执行。
  try {
    ctx.inject(['workspaceRegistry'], (c) => {
      const registry = c.get('workspaceRegistry')
      if (registry) {
        service.setRegistry(registry)
        logger.info('workspaceRegistry 已接入，删除会推送刷新')
        return
      }
      logger.warn('workspaceRegistry 取到空值')
    })
  } catch (e) {
    logger.warn(`workspaceRegistry 注入失败: ${e.message}（将直接写 workspace.json）`)
  }

  // ---- 路由 ----

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })

  const run = (fn) => async (request) => {
    try {
      let body = {}
      if (request.method === 'POST') {
        const text = await request.text()
        body = text ? JSON.parse(text) : {}
      }
      return json({ ok: true, value: await fn(body, request) })
    } catch (e) {
      // code 让前端能区分「会话仍在运行」这类可重试的情形
      return json({
        ok: false,
        error: e?.message ?? String(e),
        ...(e?.code ? { code: e.code } : {}),
        ...(e?.families ? { families: e.families } : {}),
      })
    }
  }

  // 全部用 POST：与 dsh-context 的实践一致，也避开 GET 缓存与 body 模式差异
  const routes = [
    { path: `${PREFIX}/list`, handler: run(async () => ({
      items: await service.list(),
      retentionDays: service.retentionDays,
    })) },
    // probe：删除前预检，告诉界面这个会话是否还有工作在跑
    { path: `${PREFIX}/probe`, handler: run(async (b) => service.probeActive(b.sessionId)) },
    { path: `${PREFIX}/move`, handler: run(async (b) =>
      service.moveToTrash(b.sessionId, { title: b.title, stopActivity: b.stopActivity === true })) },
    { path: `${PREFIX}/restore`, handler: run(async (b) => service.restore(b.dir)) },
    { path: `${PREFIX}/purge`, handler: run(async (b) => {
      await service.purge(b.dir)
      return { purged: b.dir }
    }) },
    { path: `${PREFIX}/purge-all`, handler: run(async () => ({ purged: await service.purgeAll() })) },
    { path: `${PREFIX}/sweep`, handler: run(async () => ({ purged: await service.sweep() })) },
    { path: `${PREFIX}/ping`, handler: run(async () => ({ pong: true, home })) },
  ]

  ctx.inject(['connection'], (c) => {
    const conn = c.get('connection')

    // 兼容多种可能的形状，逐个探测
    const candidates = [
      ['conn.fetch.register', conn?.fetch?.register],
      ['conn.routes.register', conn?.routes?.register],
      ['conn.registerFetchRoute', conn?.registerFetchRoute?.bind(conn)],
    ].filter(([, fn]) => typeof fn === 'function')

    if (!candidates.length) {
      logger.warn(
        `connection 上找不到注册方法；可用键: ${conn ? Object.keys(conn).join(',') : '(connection 为空)'}`,
      )
      return
    }

    const [chosenName, register] = candidates[0]
    logger.info(`使用注册方法: ${chosenName}`)

    for (const { path: routePath, handler } of routes) {
      try {
        c.effect(
          () =>
            register({
              path: routePath,
              methods: ['POST'],
              requestBody: 'buffered',
              fetch: handler,
            }),
          `dsh-session-trash: ${routePath}`,
        )
        logger.info(`路由已注册: POST ${routePath}`)
      } catch (e) {
        logger.warn(`路由注册失败 ${routePath}: ${e.message}`)
      }
    }
  })

  // ---- 定时清理 ----

  ctx.effect(() => {
    service.startSweeper()
    return () => service.stopSweeper()
  }, 'dsh-session-trash: retention sweeper')

  logger.info(`就绪（保留 ${retentionDays} 天，home=${home}）`)
}
