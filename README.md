# dsh-drag

把左侧边栏会话列表里的一个会话**拖到聊天记录区域松开**，一条规范的会话引用
（`@[标题](dsh-session:…)` mention）就会以引用 chip 的形式插进当前输入草稿——
发送前还能再检查一眼。dsh Web GUI 插件（DSH 0.1.5-rc.x）。

## 为什么能成立

- 侧边栏的会话行本来就是原生 HTML5 drag 源：`ui-workspace` 的 `SessionNodeItem`
  在 `dragstart` 里 `dataTransfer.setData('text/plain', node.id)`（已在
  0.1.5-rc.2 的 bundle 里核对）。缺的只是**放下的一侧**。
- 放下走的是编辑器自己的引用通道：`conversation.input.for(actx).insertReference`
  —— 与输入框内 `@`/`/` 挑选流程同一条 span-CAS 路径，插进去的是真正的 chip
  节点，而不是一段文本。
- 拖回侧边栏（`[data-row-key]` 目标）**永远不拦截**：官方的行内重排序行为原样
  保留。

## 行为

- 按住一个会话行开始拖动，指针进入聊天区域时浮出「松开以引用会话『标题』」提示；
- 在记录区域内松开 → 引用 chip 插入草稿（span 取自投放瞬间的
  `inputActions.captureInsertion()`）；
- 松开在侧边栏 → 什么都不发生（官方拖拽继续接管）；工作区分组行、文件、纯文本
  等其它拖拽源一律不激活；
- 拖放当前会话自己 → 提示「当前会话不需要引用自己」；插入被拒绝（相位/版本
  不匹配）→ 提示「会话引用插入失败」。

## 安装

```sh
# npm 注册表
dsh plugin --profile web add dsh-drag

# 或本地开发
cd ~/.dsh/profiles/web && pnpm add "dsh-drag@link:/path/to/dsh-drag"
```

`dsh.profile.bundles` 里加入 `"dsh-drag"`（`dsh plugin add` 会自动加），重启
`dsh web` 并硬刷新浏览器。

## 开发

```sh
pnpm install
pnpm build   # scripts/build.mjs — src/client.js 包进 loader 闭包写出 lib/
pnpm test    # test/smoke.mjs + scripts/interaction.mjs
```

- `test/smoke.mjs`：假 doc 手势驱动 `createDropSurface` 全部分支（mention 编码
  对齐宿主 `dsh-session-reference` 的规范形、侧边栏放行、dragend 之后 drop 失效、
  自引用提示、插入拒绝提示、apply() 的 dock 槽与 inject 面、bundle 形状）。
- `scripts/interaction.mjs`：jsdom + 真实 DragEvent 渲染真实 loader bundle，
  验证提示元素的真实 DOM 生命周期与 chip 插入链路。

浏览器半（`lib/client.js`）零依赖、零 external：不 require 任何模块，宿主服务
全部经 cordis `ctx` 注入。

## 槽位

注入 `conversation.input.dock`（由 `@deepseek-ai/dsh-client-ui-conversation`
声明，list 槽、session 作用域）。dock 条目本身渲染 `null`——它承载的是按会话
的 inject 面（`insertSessionReference` / `notify` / `captureInsertion` 闭包），
文档级拖放面在 apply() 里直接挂 document。

## License

MIT
