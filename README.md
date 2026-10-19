# dsh-session-trash · 会话回收站

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 补上**可恢复的会话删除**。

DSH 官方只提供归档（archive），没有删除。这个插件把删除做成安全的：删除不是抹掉，而是移进回收站，随时可以反悔。

- **删除即移入回收站** — 会话目录被移动，不是删除
- **7 天内随时恢复** — 恢复到原工作区、原位置，标题和排序都保留
- **到期自动清理** — 启动时扫一次，之后每 6 小时一次
- **删除后 6 秒内可撤销** — 顶部提示条，不用去回收站翻
- **回收站页面** — 搜索、排序、查看占用大小、单个恢复 / 彻底删除 / 一键清空

## 安装

### 方式一：插件管理器（推荐）

侧栏 **插件** → **添加插件** → 输入 `dsh-session-trash` → 安装 → 启用 → 重启 DSH。

### 方式二：命令行

```bash
dsh plugin --profile desktop add dsh-session-trash
```

### 方式三：从源码

```bash
git clone https://github.com/REPLACE_WITH_YOUR_USERNAME/dsh-session-trash.git
dsh plugin --profile desktop add /path/to/dsh-session-trash
```

安装后重启 DSH 生效。

## 使用

| 操作 | 位置 |
|---|---|
| 删除会话 | 侧栏会话行 → `⋯` → **删除会话**（红字带垃圾桶图标） |
| 撤销删除 | 删除后顶部提示条点 **撤销**（6 秒内） |
| 查看回收站 | 侧栏 **回收站** |
| 恢复 | 回收站条目 → **恢复** |
| 彻底删除 | 回收站条目 → **彻底删除**（不可撤销） |
| 清空回收站 | 回收站页面右上 → **全部删除** |

**快捷键**：`Ctrl/Cmd + Shift + Delete` 删除当前会话。

## 截图

> 待补充

## 数据布局

```
<DSH_HOME>/
├── sessions/<projectKey>/<sessionId>/
│   └── session.v4.jsonl.zstd          ← 会话原始位置
└── trash/
    └── 2026-10-19T09-19-52-123-session-xxxx/
        ├── meta.json                   ← 原位置、标题、删除时间
        ├── session.v4.jsonl.zstd       ← 会话本体
        └── projcache.json              ← 投影缓存（含标题）
```

`meta.json` 里保存了**编码后的 projectKey**，恢复时直接使用而不重新计算 —— 因为 DSH 的路径编码有损（`D:\a-b\c` 和 `D:\a\b\c` 会编码成同一个 key），重算可能把会话放错工作区。

## 配置

在 profile 的 `cordis.patch.yml` 中给这一行加 `config`：

```yaml
- id: dsh-session-trash
  name: dsh-session-trash
  config:
    retentionDays: 7          # 保留天数，默认 7
    sweepIntervalMs: 21600000 # 清理间隔毫秒，默认 6 小时
    home: null                # DSH home，默认读 $DSH_HOME 或 ~/.dsh
```

## 工作原理

删除时会同步维护三处状态，缺一处就会留下「幽灵会话」：

| 位置 | 处理 |
|---|---|
| `sessions/<key>/<id>/` | 移动到 `trash/` |
| `storages/workspace.json` | 从 `sessionIds` / `archivedSessionIds` / `pinnedSessionIds` 移除 |
| `storages/session_projcache/sessions/<id>.json` | 一并移入回收站（保留标题） |

界面的即时刷新依赖 DSH 自己的事件链路：

- **删除** → 发 `api-session/removed`，客户端立即移除该行
- **恢复** → 发 `api-session/added`（带完整 summary 与标题投影），客户端立即加回该行

**附件不参与回收站**。`attachments/v1/objects/` 是 SHA-256 内容寻址存储，多个会话可能引用同一对象，删除会破坏其他会话的历史。

**运行中的会话**：删除前会探测是否还有工作在跑；若有，先询问是否停止后再删除。

## HTTP 接口

挂在 `/api/dsh-session-trash/` 下，全部为精确路由（POST）：

| 路径 | 说明 |
|---|---|
| `list` | 回收站条目、保留天数 |
| `probe` | 删除前预检：会话是否仍在运行 |
| `move` | `{ sessionId, title?, stopActivity? }` |
| `restore` | `{ dir }` |
| `purge` | `{ dir }` |
| `purge-all` | 清空回收站 |
| `sweep` | 立即清理过期条目 |

## 开发

```bash
git clone https://github.com/REPLACE_WITH_YOUR_USERNAME/dsh-session-trash.git
cd dsh-session-trash
npm test
```

纯 ESM，无需构建步骤 —— `lib/*.js` 就是直接运行的源码。

```
test/service.test.mjs   35 项：路径编码、回收站增删改查、路径穿越防护、格式版本探测
test/host-e2e.test.mjs  15 项：真实 HTTP 往返，路由按 DSH 源码规则严格校验
```

## 已知限制

- **路径编码有损**：`D:\a-b\c` 与 `D:\a\b\c` 在 DSH 内部共用同一个 `projectKey`，这是 DSH 的既有行为。
- **会话格式版本**：日志文件名 `session.v<N>.jsonl.zstd` 会随 DSH 升级变化，插件会探测实际版本号，但极新格式的解析可能需要更新。
- **运行中会话停止**：停止沿用 DSH 的既有语义，被停止的回合不会继续。

## 许可

[MIT](LICENSE)
