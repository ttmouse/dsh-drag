# dsh-drag

把左侧边栏会话列表里的一个会话**拖进聊天记录区域松开**，直接打开那个会话。dsh Web GUI 插件（DSH 0.1.5-rc.x）。

## 为什么能成立

- 侧边栏的会话行本来就是原生 HTML5 drag 源：`ui-workspace` 的 `SessionNodeItem` 在
  `dragstart` 里 `dataTransfer.setData('text/plain', node.id)`（已在 0.1.5-rc.2 的
  bundle 里核对）。缺的只是**放下的一侧**。
- `shell.overlay` 是 layout 声明的全 frame 悬浮层（list 槽、可加位、默认 click-through），
  本插件的投放指示层就注册在这里，不替换任何官方条目。
- 放下时调用 `sessions.open(sessionId)` —— 与点击侧边栏行走的是同一个写入路径；
  列表快照里不存在的 id 会被忽略，绝不会动当前选中。

## 行为

- 按住一个会话行开始拖动后，聊天记录区域出现品牌色虚线高亮框；
- 松开在记录区域内 → 打开该会话；松开在区域外 → 什么都不发生（高亮消失）；
- 非会话载荷（文件路径、普通文本）不会触发投放层；未知 id 也不会。

## 安装

```sh
# npm 注册表
dsh plugin --profile web add dsh-drag

# 或本地开发
cd ~/.dsh/profiles/web && pnpm add "dsh-drag@link:/path/to/dsh-drag"
```

`dsh.profile.bundles` 里加入 `"dsh-drag"`（`dsh plugin add` 会自动加），重启 `dsh web`
并硬刷新浏览器。

## 开发

```sh
pnpm install
pnpm build   # scripts/build.mjs — 两个纯 JS 半拷进 lib/
pnpm test    # scripts/interaction.mjs — jsdom 真实 DragEvent 驱动 apply()
```

浏览器半（`lib/client.js`）零依赖：拖拽监听挂在 `document` 捕获阶段，投放层是
`shell.overlay` 之外的一个 body 直挂元素（样式与卸载都走 `ctx.effect`）。

## License

MIT
