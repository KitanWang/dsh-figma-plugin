# dsh-figma

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 Figma 设计上下文插件。
[English](README.md) | 中文

把一个 Figma 链接丢给 DSH，它就能读懂设计稿：节点的自动布局、尺寸、填充与字体，
节点绑定的设计变量（Design Token），以及一张它真的能看的渲染截图 —— 然后写出与设计一致的 UI 代码。
另外还附带四个把整套工作流固化下来的技能（Skill）。

这是 Codex 里那个 Figma 插件的 DSH 对应物。相同点与不同点见
[与 Codex Figma 插件的对比](#与-codex-figma-插件的对比)。

## 安装

```sh
dsh plugin --profile web add dsh-figma
```

然后重启 `dsh web`（新增的 bundle 在启动时合成）。

## 配置 Token

需要一个 Figma 个人访问令牌（Personal Access Token）。在
**Figma → Settings → Security → Personal access tokens** 创建
（<https://www.figma.com/developers/api#access-tokens>），至少勾选
`File content: read` 权限。

下面三种方式任选其一，按此顺序查找：

1. 插件配置里的 `accessToken`
2. Harness 凭据库中的 `FIGMA_ACCESS_TOKEN` 或 `FIGMA_TOKEN`
3. 进程环境变量中的 `FIGMA_ACCESS_TOKEN` 或 `FIGMA_TOKEN`

```sh
export FIGMA_ACCESS_TOKEN=figd_xxx
dsh web
```

验证是否生效：

> 让 Agent 调用 `figma_whoami`。

想显式写配置，就在 profile 的 `cordis.patch.yml`
（`~/.dsh/profiles/web/cordis.patch.yml`）里按 id 覆盖那一行：

```yaml
- id: figma
  config:
    accessToken: !!js process.env.FIGMA_ACCESS_TOKEN
    outputDir: .figma
```

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `figma_get_design_context` | **主力工具。** 读取一个节点：紧凑的结构化节点树 + 缩进大纲 + 渲染截图，并把节点绑定的 Figma 变量解析成名字与各模式下的值。 |
| `figma_get_screenshot` | 把一个或多个节点渲染成 PNG/JPG/SVG/PDF，落盘并作为图片附件交给模型查看。 |
| `figma_get_file` | 列出文件的页面与顶层画板 —— 只拿到文件链接时，用它找到要做的节点 id。 |
| `figma_get_variables` | 把文件里的本地变量读成设计 Token：含各模式的值，别名会被解析。可选写出 CSS 和/或 JSON。 |
| `figma_get_styles` | 已发布的填充、文字、效果、网格样式，**并且带实际取值**。 |
| `figma_get_components` | 组件与组件集，含 key、节点 id 和变体属性。 |
| `figma_get_dev_resources` | 节点上挂的开发资源（文档、工单、代码链接）。 |
| `figma_get_comments` | 评论线程及其锚定的节点。 |
| `figma_post_comment` | 在节点或画布位置上发评论。这是对 Figma 的写操作 —— 先跟用户确认。 |
| `figma_whoami` | 验证 Token 并返回当前账号。 |

所有工具都接受完整 Figma 链接（`url`）或裸文件 key（`fileKey`）；
节点 id 写成 `1-2`（URL 形式）或 `1:2`（API 形式）都可以。
design、旧的 file、proto、FigJam board、Slides 链接都能解析。

### 例子

> 把这个画板实现出来：`https://www.figma.com/design/AbC123/Home?node-id=12-345`

Agent 会调用 `figma_get_design_context`，读大纲和截图，先看仓库里已有的组件和 Token，
再写组件。`figma-design-to-code` 技能负责驱动这个流程。

## 技能（Skills）

四个技能注册进 Harness 全局技能层，因此每个 Agent 和预设都能看到：

| 技能 | 用途 |
| --- | --- |
| `figma-design-to-code` | 高保真实现画板；映射到仓库已有的组件与 Token；对照截图验证。 |
| `figma-design-system` | 盘点变量、样式、组件；产出 Token 与长期有效的规则文档。 |
| `figma-code-connect` | 生成 Code Connect 模板，把 Figma 组件绑定到代码组件。 |
| `figma-design-review` | 把实现与设计稿对比，给出可度量的差异，可选地回写成 Figma 评论。 |

## 配置项

全部可选。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `accessToken` | `''` | 显式 Token。为空时查凭据库与环境变量。 |
| `authMode` | `token` | `token` 发 `X-Figma-Token`；`oauth` 发 `Authorization: Bearer`。 |
| `apiBaseUrl` | `https://api.figma.com` | 走代理时覆盖。 |
| `requestTimeoutMs` | `30000` | 单次请求超时。 |
| `maxRetries` | `2` | 429/5xx 重试次数，遵循 `Retry-After`。 |
| `outputDir` | `.dsh-figma` | 导出目录；相对路径相对会话工作区解析。 |
| `maxNodes` | `400` | 设计上下文投影的默认节点预算。 |
| `maxDepth` | `8` | 默认深度预算。 |
| `skills` | `true` | 是否注册内置技能。 |
| `tools` | 全开 | 单工具开关：`whoami`、`file`、`designContext`、`screenshot`、`variables`、`styles`、`components`、`devResources`、`comments`、`postComment`。 |

## 与 Codex Figma 插件的对比

Codex 那个插件是三样东西拼起来的：`.codex-plugin/plugin.json` 清单、
一个 app 连接器（`.app.json` → Figma 托管的 MCP Server），
以及一堆 skill / agent / command / 写后钩子。设计智能本身在 Figma 的 MCP Server 里，
插件主要是接线加提示词素材。

DSH 有同样的**原语** —— 技能注册表（`ctx.skills`）、工具注册表（`ctx.tools`）、
子 Agent，以及 MCP 桥（`@deepseek-ai/dsh-mcp-client`）—— 但没有针对 Figma 打包好的东西。
本插件用原生方式补上这个空缺，而不是去代理 Figma 的 MCP Server，
因此只需要一个 Token，不需要开着 Figma 客户端：

| | Codex + Figma 插件 | dsh-figma |
| --- | --- | --- |
| 读设计 | Figma MCP Server（OAuth） | Figma REST API（个人访问令牌） |
| 需要开着 Figma 桌面端 | 否（托管 MCP） | 否 |
| 技能 | 7 个，Figma 官方撰写 | 4 个，针对这些工具重写 |
| 设计 Token | 走 MCP 的 `get_variable_defs` | `figma_get_variables`（多模式 + 别名解析 + CSS/JSON 导出） |
| Code Connect | MCP + Figma CLI | 技能指导生成模板；用 Figma CLI 发布 |
| 写回画布 | 支持（MCP + Plugin API） | **不支持** —— 见下 |
| 上手成本 | 装插件、授权 Figma | 装插件、配一个 Token |

### 也想要 Figma 官方的 MCP 工具？

两者可以共存。把 Harness 的 MCP 桥指向 Figma 本地的 Dev Mode Server
（Figma 桌面端 → Preferences → **Enable Dev Mode MCP Server**），
就能在 `figma_*` 之外再拿到一组 `mcp__figma__*` 工具：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: figma-devmode-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: figma
        url: http://127.0.0.1:3845/mcp
        headers: {}
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

这是最接近 Codex app 连接器的等价物，也是你确实需要「写回画布」时该走的路。
MCP 桥的 HTTP 传输只支持自定义 header，没有 OAuth 流程，
所以 Figma 的**托管** MCP 端点（`https://mcp.figma.com/mcp`）需要你自己准备 bearer token 才能用。

## 已知限制

- **不能写回画布。** 在 Figma 里创建或修改节点只能通过 Plugin API（跑在 Figma 内部）
  或 Figma 的 MCP Server。需要的话用上面的 MCP 桥。本插件是只读的。
- **变量接口需要 Figma 企业版。** `figma_get_variables` 调的接口仅对企业组织正式成员开放。
  套餐不够时会明确报错；`figma_get_styles` 仍然可用。
- **Code Connect 是「指导」而非「自动化」。** Figma REST API 里没有 Code Connect 接口。
  技能负责读组件清单并写出模板文件；发布交给 Figma CLI。
- **导出会落盘。** 截图写在 `outputDir`（默认 `<工作区>/.dsh-figma/`）下，
  记得加进 `.gitignore`。当当前模型支持图片输入时，图片也会同时作为附件内联。
- **限流是 Figma 的。** 客户端会对 429/5xx 退避重试，但逐节点遍历大文件仍可能触发限流。

## 开发

```sh
npm test                    # 52 个单元 + 集成测试，不联网
node scripts/smoke.mjs      # 在真实 Cordis 上下文中挂载并断言注册结果
```

`npm test` 会在本地起一个桩 Figma API，因此整套工具面 —— 认证头、查询构造、
渲染、写文件、Token 导出 —— 都不需要 Figma 账号就能跑通。
`scripts/smoke.mjs` 会把插件挂在 Harness 真实的 `ToolRuntime`、`SkillRegistry`、
`SystemPrompt` 服务旁边，断言工具、技能和提示词段落都注册成功。

插件没有构建步骤，除 Harness 自身的包之外没有运行时依赖。

## 许可

MIT，见 [LICENSE](LICENSE)。
