/**
 * dsh-session-trash — 浏览器半侧
 *
 * 通过 window.__ModuleLoader__ 注册。提供：
 *   1. 侧栏会话行菜单里的「删除会话」项
 *   2. 侧栏面板入口 + 回收站页面（列表 / 恢复 / 彻底删除）
 *
 * 与 Host 通信走 /api/dsh-session-trash/* （Connection 的精确 Fetch 路由）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-trash',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    // ui-primitives 是 ModuleLoader 的隐式 baseline external，官方 fixture 也是这么取的。
    // MenuItemButton 自带宿主菜单行的全部样式（14px 图标槽、8px gap、34px 行高、
    // hover/focus 填充），并且有专门的 danger prop —— 直接用官方实现，
    // 才能和「置顶/重命名/分叉/归档」这些内置行完全一致。
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
    } catch {
      primitives = {}
    }
    const MenuItemButton = primitives.MenuItemButton ?? null
    const IconTrash = primitives.IconTrashOutlineRegular ?? null

    // 顶部横幅要 portal 到 document.body（与官方 Toast 一致），
    // 否则会落在 AppFrame 的布局上下文里。
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom') ?? null
    } catch {
      ReactDOM = null
    }

    const NS = 'dsh-session-trash'
    // 必须与 Host 的 registerFetchRoute 路径逐字一致。    // 这是 /api 下的【精确路径】，不是前缀通配。
    const EP = '/api/dsh-session-trash'

    // ---------------- 字典 ----------------

    const zh = {
      'menu.delete': '删除会话',
      'menu.delete.title': '删除会话？',
      'menu.delete.desc':
        '会话将被移动到回收站，保留 {days} 天。在这期间可以从回收站恢复。',
      'menu.delete.confirm': '移到回收站',
      'menu.delete.probing': '检查中…',
      'menu.delete.activeTitle': '会话仍在运行',
      'menu.delete.activeDesc': '这个会话还有未完成的工作（{families}）。停止它们并删除，还是先取消？',
      'menu.delete.stopAndConfirm': '停止并删除',
      'menu.delete.cancel': '取消',
      'menu.delete.done': '会话已删除，可',
      'menu.delete.failed': '删除失败：{error}',

      'panel.title': '回收站',
      'panel.empty': '回收站是空的',
      'panel.emptyHint': '被删除的会话会保留在这里，{days} 天后自动清理。',
      'panel.remaining': '还剩 {days} 天',
      'panel.expired': '即将清理',
      'panel.deletedAt': '删除于 {time}',
      'panel.restore': '恢复',
      'panel.purge': '彻底删除',
      'panel.purgeConfirm': '这一步不可撤销，确定彻底删除？',
      'panel.purgeAll': '全部删除',
      'panel.purgeAllConfirm': '将彻底删除回收站里全部 {count} 个会话，此操作不可撤销。确定继续？',
      'panel.purgeAllDone': '已彻底删除 {count} 个会话',
      'panel.restoreDone': '已恢复「{title}」',
      'panel.purgeDone': '已彻底删除',
      'panel.failed': '操作失败：{error}',
      'panel.untitled': '未命名会话',
      'panel.refresh': '刷新',
      'panel.loading': '加载中…',
      'panel.count': '{count} 个会话',
      'panel.countWithSize': '{count} 个会话 · {size}',
      'panel.search': '搜索标题或路径',
      'panel.sort': '排序方式',
      'panel.sort.deleted': '按删除时间',
      'panel.sort.size': '按大小',
      'panel.sort.title': '按名称',
      'panel.noMatch': '没有匹配「{query}」的会话',
      'panel.undo': '撤销',
      'panel.undoDone': '已撤销删除',
      'panel.noSession': '当前没有可删除的会话',
    }

    const en = {
      'menu.delete': 'Delete session',
      'menu.delete.title': 'Delete this session?',
      'menu.delete.desc':
        'The session will be moved to Trash and kept for {days} days, during which you can restore it.',
      'menu.delete.confirm': 'Move to Trash',
      'menu.delete.probing': 'Checking…',
      'menu.delete.activeTitle': 'This session is still running',
      'menu.delete.activeDesc': 'Work is still in progress ({families}). Stop it and delete, or cancel?',
      'menu.delete.stopAndConfirm': 'Stop and delete',
      'menu.delete.cancel': 'Cancel',
      'menu.delete.done': 'Session deleted. You can',
      'menu.delete.failed': 'Delete failed: {error}',

      'panel.title': 'Trash',
      'panel.empty': 'Trash is empty',
      'panel.emptyHint':
        'Deleted sessions are kept here and purged automatically after {days} days.',
      'panel.remaining': '{days} days left',
      'panel.expired': 'expiring soon',
      'panel.deletedAt': 'Deleted {time}',
      'panel.restore': 'Restore',
      'panel.purge': 'Delete permanently',
      'panel.purgeConfirm': 'This cannot be undone. Delete permanently?',
      'panel.purgeAll': 'Delete all',
      'panel.purgeAllConfirm':
        'This permanently deletes all {count} sessions in Trash and cannot be undone. Continue?',
      'panel.purgeAllDone': 'Permanently deleted {count} sessions',
      'panel.restoreDone': 'Restored "{title}"',
      'panel.purgeDone': 'Permanently deleted',
      'panel.failed': 'Failed: {error}',
      'panel.untitled': 'Untitled session',
      'panel.refresh': 'Refresh',
      'panel.loading': 'Loading…',
      'panel.count': '{count} sessions',
      'panel.countWithSize': '{count} sessions · {size}',
      'panel.search': 'Search title or path',
      'panel.sort': 'Sort by',
      'panel.sort.deleted': 'Deleted time',
      'panel.sort.size': 'Size',
      'panel.sort.title': 'Name',
      'panel.noMatch': 'No session matches "{query}"',
      'panel.undo': 'Undo',
      'panel.undoDone': 'Deletion undone',
      'panel.noSession': 'No session to delete',
    }

    const dicts = { zh, en }

    function makeT(ctx) {
      const locale = ctx.get?.('locale')
      return (key, params) => {
        let lang = 'zh'
        try {
          const cur = locale?.current
          if (typeof cur === 'string') lang = cur
          else if (typeof cur === 'function') lang = cur()
          else if (cur && typeof cur === 'object' && cur.value) lang = cur.value
        } catch {}
        const dict = dicts[String(lang).toLowerCase().startsWith('en') ? 'en' : 'zh']
        let s = dict[key] ?? zh[key] ?? key
        if (params) {
          for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v))
        }
        return s
      }
    }

    // ---------------- 回收站变更广播 ----------------
    //
    // 删除入口在侧栏行菜单、恢复入口在回收站面板自身，两者之间没有 props 关系。
    // 当回收站面板正开着时在侧栏删掉一个会话，面板必须自己知道要重拉列表。
    // 这里用一个极简的订阅表做跨组件通知（不引入额外依赖）。
    const trashChanged = (() => {
      const listeners = new Set()
      return {
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        emit() {
          for (const fn of [...listeners]) {
            try {
              fn()
            } catch {
              /* 单个订阅者出错不影响其他订阅者 */
            }
          }
        },
      }
    })()

    // ---------------- 传输 ----------------

    async function call(action, body) {
      // 全部走 POST，与 Host 的 methods: ['POST'] 对齐
      const res = await fetch(`${EP}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })

      if (res.status === 404) {
        // Connection 对未注册路径返回纯文本 "not found"
        throw new Error(`路由未注册（404）。请确认 dsh-session-trash 的 Host 半侧已加载`)
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`未授权（${res.status}）`)
      }

      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`服务返回了非 JSON 内容：${text.slice(0, 80)}`)
      }
      if (!data.ok) {
        const err = new Error(data.error ?? `HTTP ${res.status}`)
        // 携带 Host 的错误码，供调用方区分「会话仍在运行」这类可重试情形
        if (data.code) err.code = data.code
        if (data.families) err.families = data.families
        throw err
      }
      return data.value
    }

    /** 字节数 → 人类可读 */
    function formatBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let v = n
      let i = 0
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
      }
      return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
    }

    /**
     * 主视图当前打开的是不是这个会话？
     * 判据与 DSH 自己一致：retainedBy.mainView > 0（见 ui-workspace/navigation.ts:484）。
     */
    function isMainViewSession(ctx, sessionId) {
      try {
        const sessions = ctx.get?.('sessions')
        const snap = sessions?.list?.getSnapshot?.()
        const row = snap?.byId?.[sessionId]
        return (row?.retainedBy?.mainView ?? 0) > 0
      } catch {
        return false
      }
    }

    /**
     * 若目标正是主视图里的会话，先让 ui-workspace 把它「清出主视图」。
     *
     * 做法是调用官方的 uiWorkspace.archiveSession —— 它内部会 clearMain()
     * （navigation.ts:367-370），主视图因此回到会话意图页。
     * 紧接着 Host 的删除流程会把该会话移进回收站，并把它从归档集合里摘掉，
     * 所以不会留下「已归档」状态。
     *
     * 失败不影响删除本身：最坏情况就是回到旧行为（主视图显示失效会话）。
     */
    async function clearMainIfCurrent(ctx, sessionId, stopActivity) {
      if (!isMainViewSession(ctx, sessionId)) return false
      try {
        const uiWorkspace = ctx.get?.('uiWorkspace')
        if (typeof uiWorkspace?.archiveSession !== 'function') return false
        await uiWorkspace.archiveSession(sessionId, stopActivity ? { stopActivity: true } : {})
        return true
      } catch {
        // 归档被拒绝（比如仍有工作在跑）时，交给下面的 move 去处理错误
        return false
      }
    }

    /** 补救：清主视图那一步归档过、但删除失败时把归档状态撤回 */
    async function unarchiveIfPossible(ctx, sessionId) {
      try {
        const uiWorkspace = ctx.get?.('uiWorkspace')
        if (typeof uiWorkspace?.unarchiveSession === 'function') {
          await uiWorkspace.unarchiveSession(sessionId)
        }
      } catch {
        /* 撤不回来就只有已归档这一副作用，不影响数据 */
      }
    }

    // ---------------- 样式 ----------------

    // 使用 DSH 真实的主题变量 --dsw-alias-*（普通 Web 应用没有原生 UI，不能靠 inherit）
    const CSS = `
      .dstrash-panel {
        /* 内容左右边界基准；头部 padding 与行 padding 都以它为起点 */
        --dstrash-pad: 12px;
        display:flex; flex-direction:column; height:100%; min-height:0; font-size:13px;
        color: var(--dsw-alias-label-primary, #e6e6e6);
        background: var(--dsw-alias-bg-base, transparent);
      }
      /* 布局基准：--dstrash-pad 是内容左右内边距。
         移植自 ui-plugin-manager 的卡片做法
         （PluginManagerPage.module.css: .card { margin: 0 -8px } + .cardHead { padding: 8px }）：
         行用负 margin 把 hover 面外扩，再用等量 padding 收回，
         于是行内内容与头部内容共用同一条边界，无需手工对齐像素。 */
      .dstrash-head {
        display:flex; align-items:center; gap:8px;
        padding:10px var(--dstrash-pad, 12px);
        border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2));
      }
      .dstrash-head-title { font-weight:600; flex:1; }
      .dstrash-btn {
        border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
        background: transparent;
        color: var(--dsw-alias-label-primary, #e6e6e6);
        border-radius:6px; padding:4px 10px; cursor:pointer;
        font-size:12px; font-family:inherit; line-height:1.4;
        box-sizing:border-box;
        text-align:center;
      }
      .dstrash-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
      .dstrash-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.2)); }
      .dstrash-btn:disabled { opacity:.45; cursor:default; }
      .dstrash-btn-danger {
        color: var(--dsw-alias-state-error-primary, #e5484d);
        border-color: var(--dsw-alias-state-error-primary, #e5484d);
      }
      /* 列表容器只留纵向留白，横向内边距交给行自己处理 */
      .dstrash-list { overflow:auto; flex:1; padding:6px 0; }
      /* 行用负 margin 把 hover 面向外扩 4px，再用等量 padding 收回，
         内容边界因此与头部共用同一条基准线（头部 padding 即 --dstrash-pad）。
         这是 ui-plugin-manager 卡片的手法（.card margin:0 -8px + .cardHead padding:8px），
         好处是不必在两个组件之间手算 padding 差值。 */
      .dstrash-item {
        display:flex; align-items:flex-start; gap:10px;
        margin:0 -4px;
        padding:9px calc(var(--dstrash-pad, 12px) + 4px) 9px calc(var(--dstrash-pad, 12px) + 4px);
        border-radius:8px;
      }
      .dstrash-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
      .dstrash-item-main { flex:1; min-width:0; }
      .dstrash-item-title {
        font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        color: var(--dsw-alias-label-primary, #e6e6e6);
      }
      .dstrash-item-meta {
        font-size:11px; margin-top:3px; display:flex; gap:10px; flex-wrap:wrap;
        color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.55));
      }
      /* gap 与头部按钮组保持一致（8px），这样两列的按钮能上下对齐 */
      .dstrash-item-actions { display:flex; gap:8px; flex-shrink:0; }
      .dstrash-empty {
        padding:36px 20px; text-align:center; line-height:1.7;
        color: var(--dsw-alias-label-secondary, rgba(230,230,230,.75));
      }
      .dstrash-warn { color: var(--dsw-alias-state-warn-primary, #f5a524); }

      /* 会话行菜单里的「删除会话」直接复用 ui-primitives 的 MenuItemButton
         （danger prop 已带 error 色与 danger hover 填充），
         所以这里不再需要任何自定义菜单行样式。 */


      /* 头部工具行：搜索 + 排序 + 按钮 */
      .dstrash-tools { display:flex; align-items:center; gap:8px; }
      .dstrash-input {
        width:150px; box-sizing:border-box;
        padding:4px 8px; font:inherit; font-size:12px;
        color: var(--dsw-alias-label-primary, #e6e6e6);
        background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.1));
        border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
        border-radius:6px; outline:none;
      }
      .dstrash-input::placeholder { color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.45)); }
      .dstrash-input:focus { border-color: var(--dsw-alias-state-business-primary, #4f8cff); }
      .dstrash-select {
        padding:4px 6px; font:inherit; font-size:12px;
        color: var(--dsw-alias-label-primary, #e6e6e6);
        background: transparent;
        border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
        border-radius:6px; cursor:pointer; outline:none;
      }
      .dstrash-size {
        font-size:11px; white-space:nowrap;
        color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.5));
      }

      /* 删除结果横幅：逐项复刻 ui-primitives 的 Toast.module.css，
         与官方「会话已归档，可撤销」完全同一外观与节奏。
         自己做而不是直接 <Toast>，是因为那个组件内部 createPortal 到
         document.body，在 shell.overlay 里挂载时实测只渲染出空白外框。
         规格来源：ui-primitives/src/Toast.module.css + Toast.tsx */
      .dstrash-banner {
        position: fixed;
        top: 40px;
        left: 50%;
        z-index: 1100;               /* 与官方一致：高于图片灯箱的 1000 */
        pointer-events: none;        /* 横幅本体不吃点击 */
        display: flex;
        align-items: center;
        gap: 10px;
        width: max-content;
        max-width: min(640px, calc(100vw - 48px));
        padding: 12px 16px;
        border-radius: var(--dsw-radius-lg, 10px);
        /* 官方提示面在两个主题下都是深色，文字固定发亮。
           这里给死兜底色，不依赖主题变量是否加载到 portal 所在位置——
           否则一旦变量取不到，就可能出现「深色块但文字同色看不见」。 */
        background: var(--dsw-alias-toast-bg, #2b3a55);
        color: var(--dsw-alias-toast-label, #ffffff);
        font-size: 14px;
        line-height: 22px;
        box-shadow: var(--dsw-shadow-lv3, 0 8px 28px rgba(0,0,0,.28));
        transform: translateX(-50%);
        animation:
          dstrash-toast-in 160ms ease-out,
          dstrash-toast-fade 1000ms ease var(--dstrash-hold, 6000ms) forwards;
      }
      .dstrash-banner-icon {
        display: grid;
        place-items: center;
        flex: none;
        color: var(--dsw-alias-state-success-primary, #3fb950);
      }
      .dstrash-banner-icon.is-warn { color: var(--dsw-alias-state-warn-label, #f5a524); }
      .dstrash-banner-text { min-width: 0; }
      .dstrash-banner-action {
        display: inline;
        padding: 0;
        border: 0;
        background: none;
        color: var(--dsw-static-deepseek-400, #79a6ff);
        font: inherit;
        cursor: pointer;
        margin-inline: 3px;
        pointer-events: auto;        /* 只有动作文字接收点击 */
      }
      .dstrash-banner-action:hover { opacity: .8; }
      @keyframes dstrash-toast-in {
        from { opacity: 0; transform: translate(-50%, -6px); }
        to   { opacity: 1; transform: translate(-50%, 0); }
      }
      @keyframes dstrash-toast-fade { to { opacity: 0; visibility: hidden; } }
      @media (prefers-reduced-motion: reduce) {
        .dstrash-banner {
          animation: dstrash-toast-fade 1000ms ease var(--dstrash-hold, 6000ms) forwards;
        }
      }


      .dstrash-toast {
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:10001;
        padding:9px 16px; border-radius:8px; font-size:13px;
        display:flex; align-items:center; gap:12px;
        background: var(--dsw-alias-bg-layer-2, #242426);
        color: var(--dsw-alias-label-primary, #e6e6e6);
        border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
        box-shadow:0 8px 28px rgba(0,0,0,.4);
      }
      .dstrash-toast-action {
        background:none; border:none; padding:0; font:inherit; font-size:13px; cursor:pointer;
        color: var(--dsw-alias-state-business-primary, #4f8cff);
      }
      .dstrash-toast-action:hover { text-decoration:underline; }
    `

    let styleEl = null
    function ensureStyle() {
      if (styleEl && document.contains(styleEl)) return
      styleEl = document.createElement('style')
      styleEl.setAttribute('data-dsh-session-trash', '')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
    }

    // ---------------- 小部件 ----------------

    function Btn({ children, onClick, danger, disabled }) {
      return h(
        'button',
        {
          className: 'dstrash-btn' + (danger ? ' dstrash-btn-danger' : ''),
          onClick,
          disabled,
          type: 'button',
        },
        children,
      )
    }

    /**
     * 轻提示状态。两种用法：
     *   1) setToast('文字') 或 setToast({ text, action })，面板内部使用，
     *      这里自带计时并在 2.4s / 6s 后自动消失；
     *   2) setToast({ seq, tone, holdMs, text, actions })，供官方 <Toast> 使用，
     *      它的消失时机由组件自己的 onDone 回调控制，这里不重复计时。
     */
    function useToast() {
      const [msg, setMsg] = useState(null)
      useEffect(() => {
        if (!msg) return
        // 交给 ResultBanner 自己的计时（它按 holdMs + 淡出算）
        if (typeof msg === 'object' && msg.seq !== undefined) return
        const hasAction = typeof msg === 'object' && msg.action
        const id = setTimeout(() => setMsg(null), hasAction ? 6000 : 2400)
        return () => clearTimeout(id)
      }, [msg])

      let node = null
      if (msg) {
        if (typeof msg === 'object' && msg.action) {
          node = h(
            'div',
            { className: 'dstrash-toast', role: 'status' },
            h('span', null, msg.text),
            h(
              'button',
              {
                type: 'button',
                className: 'dstrash-toast-action',
                onClick: () => {
                  setMsg(null)
                  msg.action.onClick?.()
                },
              },
              msg.action.label,
            ),
          )
        } else {
          node = h('div', { className: 'dstrash-toast', role: 'status' }, typeof msg === 'string' ? msg : msg.text)
        }
      }
      return [node, setMsg]
    }

    /**
     * 注意：这里【不要】用客户端 sessions.refresh() 刷新侧栏。
     *
     * refresh 会整体重拉会话列表，与 api-session/removed 写入的本地移除标记冲突，
     * 实测会把已永久删除的会话重新拉出来、掉进「未分组」。
     *
     * 恢复的刷新由 Host 侧负责：发 api-session/added（带完整 summary），
     * 客户端的 ClientSessions.handleSessionAdded 会精确地把这一行加回来。
     */

    /**
     * 顶部结果横幅（删除成功 / 撤销 / 失败）。
     *
     * 逐项复刻官方 ui-primitives 的 <Toast>：
     * 顶部居中 40px、深色面、圆角、成功态绿色圆圈勾选、动作文字蓝色可点、
     * holdMs 后淡出、淡出结束调用 onDone。
     *
     * 必须 portal 到 document.body：官方 Toast.tsx 也是这么做的，
     * AppFrame.module.css 里那句注释说明了原因——overlay 的视口内边距
     * 声明在根元素上，正是为了让「portalled to document.body」的浮层继承到。
     * 直接在 shell.overlay 就地渲染会落在 frame 的布局上下文里，位置与尺寸都不对。
     */
    function ResultBanner({ notice, onDone }) {
      useEffect(() => {
        if (!notice) return
        const hold = notice.holdMs ?? 6000
        // 与 CSS 的淡出延迟同步：160ms 入场 + hold + 1000ms 淡出
        const id = setTimeout(() => onDone(), hold + 1000)
        return () => clearTimeout(id)
      }, [notice, onDone])

      if (!notice) return null
      const success = notice.tone === 'success'
      // 兜底：任何情况下都要有可见文字，避免只渲染出一个空的外框
      const text =
        typeof notice.text === 'string' && notice.text.trim()
          ? notice.text
          : success
            ? '会话已删除，可'
            : '操作失败'
      const actions = Array.isArray(notice.actions) ? notice.actions : []

      const node = h(
        'div',
        {
          className: 'dstrash-banner',
          role: 'alert',
          style: { '--dstrash-hold': `${notice.holdMs ?? 6000}ms` },
        },
        h(
          'span',
          { className: 'dstrash-banner-icon' + (success ? '' : ' is-warn'), 'aria-hidden': 'true' },
          success
            ? h(
                'svg',
                {
                  width: 16,
                  height: 16,
                  viewBox: '0 0 16 16',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.4,
                },
                h('circle', { cx: 8, cy: 8, r: 6.5 }),
                h('path', { d: 'M5.2 8.1l2 2 3.6-3.9', strokeLinecap: 'round', strokeLinejoin: 'round' }),
              )
            : h(
                'svg',
                {
                  width: 16,
                  height: 16,
                  viewBox: '0 0 16 16',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.4,
                },
                h('circle', { cx: 8, cy: 8, r: 6.5 }),
                h('path', { d: 'M8 4.8v4.2', strokeLinecap: 'round' }),
                h('path', { d: 'M8 11.2v.8', strokeLinecap: 'round' }),
              ),
        ),
        h(
          'span',
          { className: 'dstrash-banner-text' },
          text,
          actions.map((a) =>
            h(
              'button',
              {
                key: a.label,
                type: 'button',
                className: 'dstrash-banner-action',
                onClick: a.onClick,
              },
              a.label,
            ),
          ),
        ),
      )

      // 挂到 document.body，与官方 Toast 的 createPortal 一致
      if (ReactDOM?.createPortal && typeof document !== 'undefined' && document.body) {
        try {
          return ReactDOM.createPortal(node, document.body)
        } catch {
          return node
        }
      }
      return node
    }

    // ---------------- 回收站页面 ----------------

    function TrashPanel({ ctx, t }) {
      const [items, setItems] = useState([])
      const [days, setDays] = useState(7)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(null)
      const [toast, setToast] = useToast()
      const [query, setQuery] = useState('')
      const [sortBy, setSortBy] = useState('deleted')   // deleted | size | title

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const v = await call('list')
          setItems(v.items ?? [])
          setDays(v.retentionDays ?? 7)
        } catch (e) {
          setToast(t('panel.failed', { error: e.message }))
        } finally {
          setLoading(false)
        }
      }, [t, setToast])

      useEffect(() => {
        ensureStyle()
        void load()
      }, [load])

      // 从侧栏菜单删除会话时，回收站面板可能正开着。
      // 那个操作走的是 shell.overlay 里的对话框，与本组件没有 props 关系，
      // 所以要靠一个模块级广播把「内容变了」通知过来，否则要切走再切回才更新。
      useEffect(() => trashChanged.subscribe(() => void load()), [load])

      // 搜索 + 排序后的展示列表（只影响显示，不影响任何写操作）
      const visible = useMemo(() => {
        const q = query.trim().toLowerCase()
        let list = items
        if (q) {
          list = list.filter((it) => {
            const title = (it.title || '').toLowerCase()
            const path = (it.workspacePath || '').toLowerCase()
            return title.includes(q) || path.includes(q)
          })
        }
        const sorted = [...list]
        if (sortBy === 'size') sorted.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
        else if (sortBy === 'title') sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
        // deleted 保持服务端给的顺序（已按删除时间倒序）
        return sorted
      }, [items, query, sortBy])

      // 总占用只按当前全部条目统计，不受搜索影响
      const totalBytes = useMemo(
        () => items.reduce((sum, it) => sum + (it.sizeBytes ?? 0), 0),
        [items],
      )

      const onRestore = async (it) => {
        setBusy(it.dir)
        try {
          // Host 在恢复的最后一步会发 api-session/added，
          // 客户端自己就会把这一行加回来，这里不需要再触发会话列表刷新。
          await call('restore', { dir: it.dir })
          setToast(t('panel.restoreDone', { title: it.title || t('panel.untitled') }))
          trashChanged.emit()
        } catch (e) {
          setToast(t('panel.failed', { error: e.message }))
        } finally {
          setBusy(null)
        }
      }

      // 撤销：把刚删的条目恢复回原工作区
      const undoDelete = async (dir) => {
        try {
          await call('restore', { dir })
          setToast(t('panel.undoDone'))
          trashChanged.emit()
        } catch (e) {
          setToast(t('panel.failed', { error: e.message }))
        }
      }

      const onPurge = async (it) => {
        if (!window.confirm(t('panel.purgeConfirm'))) return
        setBusy(it.dir)
        try {
          await call('purge', { dir: it.dir })
          setToast(t('panel.purgeDone'))
          trashChanged.emit()
        } catch (e) {
          setToast(t('panel.failed', { error: e.message }))
        } finally {
          setBusy(null)
        }
      }

      // 清空回收站：不可撤销，二次确认里把条目数写进去
      const onPurgeAll = async () => {
        if (!items.length) return
        if (!window.confirm(t('panel.purgeAllConfirm', { count: items.length }))) return
        setBusy('__all__')
        try {
          const v = await call('purge-all')
          setToast(t('panel.purgeAllDone', { count: v?.purged ?? items.length }))
          trashChanged.emit()
        } catch (e) {
          setToast(t('panel.failed', { error: e.message }))
        } finally {
          setBusy(null)
        }
      }

      const fmt = (ms) => {
        try {
          return new Date(ms).toLocaleString()
        } catch {
          return ''
        }
      }

      const list = loading && !items.length
        ? h('div', { className: 'dstrash-empty' }, t('panel.loading'))
        : items.length === 0
          ? h(
              'div',
              { className: 'dstrash-empty' },
              h('div', null, t('panel.empty')),
              h('div', { style: { fontSize: 12 } }, t('panel.emptyHint', { days })),
            )
          : visible.length === 0
            ? h('div', { className: 'dstrash-empty' }, t('panel.noMatch', { query }))
            : h(
                'div',
                { className: 'dstrash-list' },
                visible.map((it) =>
                h(
                  'div',
                  { className: 'dstrash-item', key: it.dir },
                  h(
                    'div',
                    { className: 'dstrash-item-main' },
                    h('div', { className: 'dstrash-item-title', title: it.title }, it.title || t('panel.untitled')),
                    h(
                      'div',
                      { className: 'dstrash-item-meta' },
                      h('span', null, t('panel.deletedAt', { time: fmt(it.deletedAtMs) })),
                      h(
                        'span',
                        { className: it.expired ? 'dstrash-warn' : undefined },
                        it.expired ? t('panel.expired') : t('panel.remaining', { days: it.remainingDays }),
                      ),
                      it.sizeBytes != null
                        ? h('span', { className: 'dstrash-size' }, formatBytes(it.sizeBytes))
                        : null,
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dstrash-item-actions' },
                    h(
                      Btn,
                      { onClick: () => onRestore(it), disabled: busy === it.dir },
                      t('panel.restore'),
                    ),
                    h(
                      Btn,
                      { onClick: () => onPurge(it), disabled: busy === it.dir, danger: true },
                      t('panel.purge'),
                    ),
                  ),
                ),
              ),
            )

      return h(
        'div',
        { className: 'dstrash-panel' },
        h(
          'div',
          { className: 'dstrash-head' },
          h('div', { className: 'dstrash-head-title' }, t('panel.title')),
          h(
            'span',
            { style: { fontSize: 11, opacity: 0.6 } },
            items.length
              ? t('panel.countWithSize', { count: items.length, size: formatBytes(totalBytes) })
              : t('panel.count', { count: 0 }),
          ),
          // 搜索与排序：只在有条目时出现
          items.length > 0 &&
            h(
              'div',
              { className: 'dstrash-tools' },
              h('input', {
                className: 'dstrash-input',
                type: 'search',
                value: query,
                placeholder: t('panel.search'),
                onChange: (e) => setQuery(e.currentTarget.value),
              }),
              h(
                'select',
                {
                  className: 'dstrash-select',
                  value: sortBy,
                  onChange: (e) => setSortBy(e.currentTarget.value),
                  title: t('panel.sort'),
                },
                h('option', { value: 'deleted' }, t('panel.sort.deleted')),
                h('option', { value: 'size' }, t('panel.sort.size')),
                h('option', { value: 'title' }, t('panel.sort.title')),
              ),
            ),
          // 顺序与列表中每行一致：危险操作在左、普通操作在右。
          // 这样「全部删除」与行的「彻底删除」上下对齐，「刷新」与「恢复」对齐。
          items.length > 0 &&
            h(
              Btn,
              { onClick: onPurgeAll, disabled: busy === '__all__' || loading, danger: true },
              t('panel.purgeAll'),
            ),
          h(Btn, { onClick: load, disabled: loading }, t('panel.refresh')),
        ),
        list,
        toast,
      )
    }

    // ---------------- 插件主体 ----------------

    let rootCleanup = null

    function apply(ctx) {
      const t = makeT(ctx)

      // 待确认的删除请求：由菜单项写入，由 shell.overlay 条目渲染。
      // 顶部结果横幅的可订阅状态（替代原来的确认对话框机制）。
      // 删除不再弹确认框，而是直接执行，结果通过这条横幅反馈：
      // 成功 → 「会话已删除，可 撤销」；失败 → 具体原因。
      const noticeState = { current: null, listeners: new Set() }
      const setNotice = (v) => {
        noticeState.current = v
        for (const fn of noticeState.listeners) fn()
      }
      const useNotice = () => {
        const [, force] = useState(0)
        useEffect(() => {
          const fn = () => force((n) => n + 1)
          noticeState.listeners.add(fn)
          return () => noticeState.listeners.delete(fn)
        }, [])
        return noticeState.current
      }

      /**
       * 执行一次删除：直接移入回收站，成功后给可撤销的横幅。
       *
       * @param sessionId 目标会话
       * @param title 用于横幅与撤销文案
       * @param stopActivity 是否已确认要停止运行中的工作
       */
      const deleteSession = async (sessionId, title, stopActivity = false) => {
        try {
          // 若删的是主视图里打开的会话，先走官方归档把它从主视图摘掉，
          // 否则页面会挂着一条已不存在的会话（标题退化成 sessionId）。
          const archived = await clearMainIfCurrent(ctx, sessionId, stopActivity)

          let meta
          try {
            meta = await call('move', { sessionId, title, stopActivity })
          } catch (moveError) {
            // 为清主视图而归档过、删除却失败：把归档撤回来，别留下副作用
            if (archived) await unarchiveIfPossible(ctx, sessionId)
            throw moveError
          }

          trashChanged.emit()
          setNotice({
            seq: Date.now(),
            tone: 'success',
            holdMs: 6000,
            text: t('menu.delete.done'),
            actions: meta?.dir
              ? [
                  {
                    label: t('panel.undo'),
                    onClick: () => {
                      setNotice(null)
                      call('restore', { dir: meta.dir })
                        .then(() => trashChanged.emit())
                        .catch(() => {})
                    },
                  },
                ]
              : [],
          })
        } catch (e) {
          // 会话有工作在跑：问一次要不要停下再删。
          // 这里用原生 confirm 而不是自绘对话框——确认框本身被去掉了，
          // 只有这种破坏性分支才需要再问一次。
          if (e?.code === 'SESSION_ACTIVE') {
            const families = Array.isArray(e.families) && e.families.length ? e.families.join('、') : ''
            const ok = window.confirm(
              families
                ? t('menu.delete.activeDesc', { families, days: 7 })
                : t('menu.delete.activeTitle'),
            )
            if (ok) return deleteSession(sessionId, title, true)
            return
          }
          setNotice({
            seq: Date.now(),
            tone: 'warning',
            holdMs: 6000,
            text: t('menu.delete.failed', { error: e?.message ?? String(e) }),
          })
        }
      }

      // 0) 快捷键：Mod+Shift+Delete 删除当前会话
      //
      // 与内置 session.rename / session.fork / session.archive 同一套注册方式
      // （见 ui-workspace/src/client/shortcuts.ts）。拿到 snippets 里的
      // shortcuts 服务时——它由 dsh-client-shortcuts 提供，可能不存在。
      try {
        ctx.inject(['shortcuts', 'sessions', 'layout'], (c) => {
          const shortcuts = c.get('shortcuts')
          const sessions = c.get('sessions')
          const layout = c.get('layout')
          if (!shortcuts || typeof shortcuts.register !== 'function') return

          // 主视图里正在看的那个会话
          const current = () => {
            try {
              const snap = sessions?.list?.getSnapshot?.()
              const byId = snap?.byId ?? {}
              return Object.values(byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)
            } catch {
              return undefined
            }
          }

          c.effect(
            () =>
              shortcuts.register({
                id: 'dsh-session-trash.delete',
                label: () => t('menu.delete'),
                aliases: ['delete session', 'move session to trash'],
                defaults: {
                  'desktop:macos': { code: 'Delete', modifiers: ['primary', 'shift'] },
                  'desktop:windows': { code: 'Delete', modifiers: ['primary', 'shift'] },
                  'desktop:linux': { code: 'Delete', modifiers: ['primary', 'shift'] },
                  'web:macos': { code: 'Delete', modifiers: ['primary', 'shift'] },
                  'web:windows': { code: 'Delete', modifiers: ['primary', 'shift'] },
                },
                regions: ['page', 'editable'],
                modals: [],
                resolve: (context) => {
                  const target = current()
                  const panelActive = (() => {
                    try {
                      return layout?.panelInfo?.getSnapshot?.().activePanelId != null
                    } catch {
                      return false
                    }
                  })()
                  if (target === undefined || panelActive || context?.modal != null) {
                    return { status: 'blocked', reason: t('panel.noSession') }
                  }
                  return { status: 'handled', run: () => { void deleteSession(target.id, target.title ?? '') } }
                },
              }),
            'dsh-session-trash: shortcut',
          )
        })
      } catch {
        /* 没有 shortcuts 服务就只是没有快捷键，不影响其它功能 */
      }

      rootCleanup = () => {
        noticeState.listeners.clear()
        styleEl?.remove()
        styleEl = null
      }

      // 1) 会话行菜单项
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'dsh-session-trash.delete',
            order: 500,
            locale: NS,
          },
          (props) => {
            const { sessionId, displayTitle, useMenuOpenState } = props
            // 菜单项可能先于面板/对话框出现，必须自己确保样式已注入
            ensureStyle()
            const [, setMenuOpen] = useMenuOpenState ? useMenuOpenState() : [null, () => {}]
            const onClick = () => {
              setMenuOpen?.(false)
              // 直接删除，不弹确认框；结果由顶部横幅反馈
              void deleteSession(sessionId, typeof displayTitle === 'string' ? displayTitle : '')
            }

            // 用官方 MenuItemButton：
            //   danger       → 文字与图标用 error 色，hover 用 danger 填充
            //                  （Menu.module.css 的 .danger / .danger .itemIcon）
            //   icon         → 走 .itemIcon 的 14×14 图标槽，自带 8px gap 与垂直居中
            //   separatorBefore → 复用官方的分隔线
            // 这样和「置顶 / 重命名 / 分叉 / 归档 / 复制 Session ID」完全同构。
            if (MenuItemButton) {
              return h(
                MenuItemButton,
                {
                  danger: true,
                  separatorBefore: true,
                  icon: IconTrash ? h(IconTrash, { size: 14 }) : undefined,
                  onSelect: onClick,
                },
                t('menu.delete'),
              )
            }

            // 兜底（拿不到 primitives 时）：按 Menu.module.css 的数值复刻
            // .item（13px/20px 行高、6px 8px 内边距、≥34px 高）+ .itemIcon（14px 槽）
            return h(
              'button',
              {
                type: 'button',
                role: 'menuitem',
                onClick,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  boxSizing: 'border-box',
                  minHeight: 34,
                  padding: '6px 8px',
                  margin: 0,
                  border: 'none',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'var(--dsw-alias-state-error-primary, #e5484d)',
                  font: 'inherit',
                  fontSize: 13,
                  lineHeight: '20px',
                  textAlign: 'left',
                  cursor: 'pointer',
                },
              },
              h(
                'span',
                {
                  key: 'icon',
                  style: {
                    display: 'inline-flex',
                    flex: 'none',
                    width: 14,
                    height: 14,
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'inherit',
                  },
                },
                h(
                  'svg',
                  {
                    width: 14,
                    height: 14,
                    viewBox: '0 0 16 16',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1,
                    'aria-hidden': 'true',
                  },
                  h('path', { d: 'M1.28149 3.88831H14.7187' }),
                  h('path', { d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833' }),
                  h('path', { d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831' }),
                  h('path', { d: 'M6.44946 6.98926V11.1238' }),
                  h('path', { d: 'M9.55054 6.98926V11.1238' }),
                ),
              ),
              h('span', { key: 'label', style: { flex: 1, minWidth: 0 } }, t('menu.delete')),
            )
          },
        ),
      )

      // 2) 顶部结果横幅（跨面板存活）
      //
      // 删除不再弹确认框，所以这里只剩横幅：
      // 成功显示「会话已删除，可 撤销」，失败显示具体原因。
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-session-trash.banner', locale: NS }, () => {
          ensureStyle()
          const notice = useNotice()
          return h(ResultBanner, { notice, onDone: () => setNotice(null) })
        }),
      )

      // 3) 侧栏面板入口
      //
      // 规范（见 ui-sidebar/SidebarRoot.module.css + 官方 PluginsPanelIcon /
      // TaskManagerIcon 两个参考实现）：
      //   - 行布局由宿主负责：.panelRow 已是 flex + align-items:center + gap:8px +
      //     min-height:36px + line-height:22px，图标槽 .panelGlyph 也由宿主包好；
      //   - 组件只返回「图标元素本身」，尺寸用宿主传入的 size（展开 16 / 折叠 18）；
      //   - 绝不自己加 div/span 包装，否则会变成行内 line box 的基线，
      //     把图标顶上去、与文字错位；
      //   - 文字由宿主的 label 渲染，组件里不能再输出文字。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'dsh-session-trash',
            order: 60,
            label: () => t('panel.title'),
            locale: NS,
          },
          (props) => {
            const size = typeof props?.size === 'number' ? props.size : 16

            // 首选官方图标：与「插件 / 插件市场 / 自动化任务 / 上下文洞察」
            // 同一套 16-viewBox 线稿，笔画权重一致。
            if (IconTrash) return h(IconTrash, { size })

            // 兜底：同一份 artwork，尺寸透传宿主给的 size
            return h(
              'svg',
              {
                width: size,
                height: size,
                viewBox: '0 0 16 16',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1,
                'aria-hidden': 'true',
                focusable: 'false',
              },
              h('path', { d: 'M1.28149 3.88831H14.7187' }),
              h('path', { d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833' }),
              h('path', { d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831' }),
              h('path', { d: 'M6.44946 6.98926V11.1238' }),
              h('path', { d: 'M9.55054 6.98926V11.1238' }),
            )
          },
        ),
      )

      // 4) 主面板页面
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'dsh-session-trash',
            locale: NS,
          },
          () => {
            ensureStyle()
            return h(TrashPanel, { ctx, t })
          },
        ),
      )
    }

    return {
      name: 'dsh-session-trash',
      inject: ['slots', 'locale'],
      apply,
      dispose() {
        rootCleanup?.()
      },
    }
  },
})
