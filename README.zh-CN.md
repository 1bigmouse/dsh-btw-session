# Btw 临时会话

[English](./README.md) | 中文

在右侧边栏就当前对话提出一次性旁问：**不进入原对话上下文**，单独统计这条侧边
线程的 token 用量，关闭即丢弃，不留任何痕迹。

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的
第三方插件包（bundle），不属于 DSH 本体。

## 安装

**兼容性**：在 **DSH 0.2.2-rc.3**（桌面版与 CLI）上验证；更早的版本未做兼容，
可能缺少本插件注册的右侧边栏标签页插槽。

从 GitHub 直接安装：

```sh
dsh plugin --profile <profile> add github:1bigmouse/dsh-btw-session
```

想固定到具体某个提交，在地址后面加上提交号：

```sh
dsh plugin --profile <profile> add github:1bigmouse/dsh-btw-session#<sha>
```

也可以克隆仓库后按本地目录安装（桌面版可在 **插件 → 添加插件** 中选择克隆下来的
目录）：

```sh
git clone https://github.com/1bigmouse/dsh-btw-session
dsh plugin --profile <profile> add ./dsh-btw-session
```

这个包是纯 ESM JavaScript，安装后不需要构建，也不涉及 pnpm 的 `allowBuilds`
授权。

## 使用

1. 从右侧边栏的引导中打开 **Btw**，或在输入框输入 `/btw <问题>`，面板会在右侧打开。
2. 在面板自己的输入框里继续追问。每次回答都以当前会话（只读）加上面板内已有的
   问答为上下文，并且可以只读地查看工作区文件。每条回答底部都带复制按钮。
3. 对话下方的用量行只统计这条侧边线程——提问数与解码速度，然后是 token 与缓存
   命中率。点击该行可展开完整明细。
4. 点 **关闭并遗忘**（或直接关闭标签页）即丢弃线程；下次打开是空的。

## 不做的事

- 不向原会话写入任何消息、轮次、工具调用或助手消息；侧边线程的任何内容都不会
  成为原会话的模型上下文，它执行的查询也不会向原会话写入 `tool/call` 或
  `tool/result` 事件。
- 只能读。`read`、`glob`、`grep` 使用与会话相同的沙箱和工作目录运行，白名单里
  没有任何能写入、修改、打补丁或执行命令的工具。把 `tools` 设为 `[]` 就只依据
  上下文回答。
- 没有子代理、没有审批流程、没有联网工具。
- 不持久化。线程只存在于该会话对应的 Host 进程内存里；关闭面板、刷新页面或重启
  Host 都会丢弃它。
- `/btw` 命令本身仍会作为「已运行的命令」记入会话日志，因为运行任何命令都会如此；
  但问题与回答不在记录中。

## 配置

`cordis.patch.yml` 中的 Host 行接受以下字段：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxExchanges` | `20` | 新提问时重放的侧边线程历史轮数 |
| `maxContextMessages` | `80` | 单次侧边请求带入的原会话消息数 |
| `maxContextChars` | `48000` | 原会话上下文的字符预算，从最旧的开始丢弃 |
| `maxOutputTokens` | `8192` | 单条回答的输出上限；推理 token 也计入其中 |
| `tools` | `["read","glob","grep"]` | 侧边回答可调用的只读工具；`[]` 表示仅用上下文回答 |
| `maxToolRounds` | `4` | 返回回答前允许的工具轮数 |
| `route` | `null` | 固定的 `{ provider, model }`；默认沿用会话自己的路由 |
| `systemPrompt` | `null` | 替换侧边提问的系统提示词 |

## 安全与隐私

- **没有遥测，也没有自己的服务端。** 每条回答都是一次经会话已配置路由的
  `ctx.llm.stream` 调用；插件不联系其他任何地址，不读取环境变量或凭据存储，也不
  向作者发送任何内容。
- **不落盘。** 线程只存在于 Host 进程内存中，按父会话 id 索引，关闭、刷新或重启即
  删除；问题与回答不会生成文件、数据库记录或会话事件。
- **只读查询。** 只有 `read`、`glob`、`grep` 可以运行，且仅当父会话最后一次请求
  本身提供了这些工具；`maxToolRounds` 限制轮数，白名单之外的调用不会真正执行。
- **路由由框架把关。** 面板通过 DSH 自带认证的 `/api` 通道通信：请求携带浏览器
  的 DSH 会话 Cookie，并通过框架的主机/来源检查后才会进入处理函数。插件本身不加
  token、不加 Cookie、不设置 CORS，也不做来源判断。信任边界是这个 DSH profile 的
  所有者——已受该 profile 信任的页面可以访问其中任意会话 id。
- **回答无法变成代码。** Markdown 以 React 元素渲染，原始 HTML 永不被解释，链接
  与图片地址只允许 `http:`、`https:`、`mailto:`。

## 开发与验证

```sh
npm test          # 或：node tests/verify.mjs
```

测试用桩 Cordis 上下文同时加载 Host 与浏览器两半，覆盖命令、三条路由、请求组装、
指标折算以及全部客户端注册（标签页类型、引导入口、面板主体、命令行、关闭处理）。
不需要联网，也不需要安装 DSH，因此同一命令可在 GitHub Actions 的 Node 22 与 24
上运行。

## 社区

插件介绍与讨论帖（DeepSeek Harness Discussions）：
https://github.com/deepseek-ai/deepseek-harness/discussions/13685

## 许可证

[MIT](./LICENSE) © 2026 1bigmouse
