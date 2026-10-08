# dsh-drag

把左侧边栏会话列表里的一个会话**拖到聊天记录区域松开**，一条规范的会话引用
（`@[标题](dsh-session:…)` mention）就会以引用 chip 的形式插进当前输入草稿——
发送前还能再检查一眼。dsh Web GUI 插件，声明兼容 DSH
`>=0.1.5-rc.2 <0.2.0-0 || >=0.2.0-rc.2 <0.3.0-0`（web 端 0.1.5-rc.2 起、
桌面端 0.2.0-rc.2 起）。

## 为什么能成立

- 侧边栏的会话行本来就是原生 HTML5 drag 源：`ui-workspace` 的 `SessionNodeItem`
  在 `dragstart` 里 `dataTransfer.setData('text/plain', node.id)`（已在
  0.1.5-rc.2 的 bundle 里核对）。缺的只是**放下的一侧**。
- 放下走的是编辑器自己的引用通道：`conversation.input.for(actx).insertReference`
  —— 与输入框内 `@`/`/` 挑选流程同一条 span-CAS 路径，插进去的是真正的 chip
  节点，而不是一段文本。
- `dragover`/`drop` 挂在 **document 捕获阶段**并 `stopPropagation()`：输入框是
  Lexical 编辑器，它在编辑器根节点上自己监听 `drop`，会把 `text/plain` 载荷
  （也就是裸 session id）当文本贴进草稿——冒泡阶段拦已经太晚，捕获阶段才行。
  `dragstart`/`dragend` 仍走冒泡：会话行的 payload 由它自己的 handler 先写。
- `dragstart` 里把 `effectAllowed` 从行自带的 `move` 放宽成 `copyMove`：声明
  `move` 的拖拽配 `dropEffect = 'copy'` 不是合法组合，Chrome 宽容、严格的引擎会
  直接拒绝这次放下。
- 拖回侧边栏（`[role="tree"]` 里的任何行）**永远不拦截**：官方的行内重排序行为
  原样保留。

## 行为

- 按住一个会话行开始拖动，指针进入聊天区域 → 接受投放（光标出现"复制"角标）；
- 在记录区域内松开 → 引用 chip 插入草稿（span 取自投放瞬间的 `caretSpan()`
  + `snapshot.draftRev`）；
- 松开在侧边栏 → 什么都不发生（官方拖拽继续接管）；工作区分组行、文件、纯文本
  等其它拖拽源一律不激活；
- 聊天列（`[data-conversation-content]`）**永远优先放行**：轨迹视图那类自带
  `role="tree"` 的 JSON 树渲染在聊天列内部，不能被当成侧边栏而拒收；
- 拖放当前会话自己 → 提示「当前会话不需要引用自己」；插入被拒绝（相位/版本
  不匹配）→ 提示「会话引用插入失败」；找不到可插入的 composer（主面板没有会话）
  → 静默不插，但会在控制台留下 `[dsh-drag] drop ignored: …` 一条警告。

**不画任何自己的浮层**：拖动时的视觉反馈只有浏览器原生的拖影（跟随鼠标的会话行
副本）和上面那个复制角标。早期版本额外弹了一个「松开以引用会话『标题』」气泡，
结果就是光标旁边出现两条标题，纯噪音，已删除。

## 安装

```sh
# 从 GitHub（收录 dsh-market 后市场走的也是这条源）
dsh plugin --profile web add github:ttmouse/dsh-drag

# 或本地开发
cd ~/.dsh/profiles/web && pnpm add "dsh-drag@link:/path/to/dsh-drag"
```

`lib/` 已随仓库提交（`pnpm build` 的产物），所以 GitHub 安装不需要构建授权。
`dsh.profile.bundles` 里加入 `"dsh-drag"`（`dsh plugin add` 会自动加），重启
`dsh web` 并硬刷新浏览器。

## 宿主版本声明

`package.json` 声明 `dsh.manifestVersion: 1` 与
`engines.dsh: ">=0.1.5-rc.2 <0.2.0-0 || >=0.2.0-rc.2 <0.3.0-0"`。

- 下限 `0.1.5-rc.2` 是实际核对过 bundle 的版本；`0.2.0-rc.2` 是桌面端内置的那条
  线。**0.2.0-rc.2 曾经让拖放静默失效**：那一版把 `SessionListState.current` 删了
  （状态只剩 `{ ids, byId, phase, projectionsBySession }`），而插件当时正用它解析
  投放目标，于是 `resolveFace()` 恒返回 null——拖拽会 arm、`dragover` 会接受并显示
  复制角标，但松开后既不插 chip 也不报错。现在的解析法见下面「投放目标怎么来的」，
  旧宿主仍走 `current` 回退。教训：只做「这些 API 还在」的存在性核对不足以声称兼容，
  真正要核的是**取值语义**。
- 为什么要两段 `||`：node-semver 只在范围里存在「同 major.minor.patch 且自身带
  预发布标签」的比较符时才放行预发布版本——`<0.2.0-0` 与 `>=0.2.0-rc.2` 就是为此
  存在的。dsh-market 读这个字段时用 `includePrerelease: true`，于是 `0.1.5-rc.2`
  起的每个 `0.1.x` / `0.2.x` 预发布宿主都落在范围内，`0.1.4` 及以下、`0.2.0-rc.1`
  与 `0.3.0` 起不在。
- 这两个字段是**声明**，不强制：官方 `@deepseek-ai/dsh-package-manifest` 明说
  「当前安装器与加载器不强制检查 `dsh.manifestVersion` 或 `engines.dsh`」，它们
  只决定市场卡片显示的宿主要求与兼容性过滤。

## 开发

```sh
pnpm install
pnpm build   # scripts/build.mjs — src/client.js 包进 loader 闭包写出 lib/
pnpm test    # test/smoke.mjs + test/apply-wiring.mjs + test/session-resolution.mjs + scripts/interaction.mjs
```

- `test/session-resolution.mjs`：闸住「当前会话」的两种列表形态——0.2.0-rc.2 的
  `{ ids, byId, phase, projectionsBySession }`（无 `current`，靠 `retainedBy.mainView`
  选出主面板会话）与旧宿主的 `current`，外加「主视图没有会话时惰性无操作」。把这处
  解析回滚成 `sessions.list.getSnapshot().current`，只有它会红（`apply-wiring.mjs`
  喂的是插件自己假设的形状，看不见这类漂移）。

- `test/apply-wiring.mjs`：**只经 `apply(ctx)`** 驱动整条链路（假 document +
  假宿主服务）：断言四个 document 监听真的被装上、`dragover`/`drop` 的**相位**是
  捕获、接受时确实 `stopPropagation`、`effectAllowed` 被放宽、一次完整拖放手势能
  插 chip、span 取的是 `caretSpan()` + `snapshot.draftRev`、侧边栏与工作区行一律
  放行、surface 挂在 inject scope 上（不是 root fiber）、dispose 撤干净。0.1.0 的
  bug 是 `apply()` 压根没挂 surface（模块导出的 `createDropSurface` 自己是对的，
  老测试直接调它所以全绿）——这个文件就是为它存在的回归闸门：把 `src/client.js`
  回滚到修复前，只有它会红；把上面任一条改坏也会红。
- `test/smoke.mjs`：假 doc 手势驱动 `createDropSurface` 全部分支（mention 编码
  对齐宿主 `dsh-session-reference` 的规范形、侧边栏放行、dragend 之后 drop 失效、
  自引用提示、插入拒绝提示、apply() 的 dock 槽与 inject 面、bundle 形状）。
- `scripts/interaction.mjs`：jsdom + 真实冒泡事件渲染真实 loader bundle，**只调
  `apply(ctx)`**，在真实 DOM（侧边栏树 + 聊天区）上跑完整手势，并断言插件没有往
  文档里插任何节点（自定义浮层回归会直接红）。

改完 `pnpm build` 不需要重启 `dsh web`：bundle 路由按内容哈希取当前字节，
浏览器硬刷新即可拿到新版本。

浏览器半（`lib/client.js`）零依赖、零 external：不 require 任何模块，宿主服务
全部经 cordis `ctx` 注入。

## 投放目标怎么来的

投放时**现算**目标输入机：先解析「主面板正在展示的会话」→ `sessions.scope(id)` →
`conversation.input.for(actx)`，再取 `caretSpan()`（detect 坐标的光标 span）和
`snapshot.draftRev`（输入机版本号，span CAS 用）调 `insertReference`。所以拖放面
不依赖任何槽位渲染，挂载只发生在 `apply()` 里。

那一步「当前会话」在两个宿主形态间取值（`currentSessionIdOf`）：

- `0.1.5-rc.x` 及以前：`sessions.list.getSnapshot().current` 直接给 id；
- `0.2.0-rc.2` 起：该字段没了，改成宿主自己反复用的那条谓词——`byId` 里
  `retainedBy.mainView > 0` 的那一行就是主面板里的会话（ui-layout、ui-cordis、
  ui-open-in-app、ui-settings-general、ui-workspace 的 `mainSessionId` 与
  ui-session 的 `isMain` 全是这个语义）。

先读 `current`、读不到再扫 `byId`，所以同一份构建同时服务两种宿主。

`conversation.input.dock` 里仍注册了一个渲染 `null` 的条目（`id: dsh-drag`，
order 40）——**目前没有任何代码消费它的 inject 面**，它是上一版设计的遗留，可以
直接删掉；留着只是无害。文档级拖放面在 apply() 里直接挂 document。

## License

MIT
