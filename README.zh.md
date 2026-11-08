# dsh-inline-pi-agent

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里运行 [pi coding agent](https://github.com/earendil-works/pi) 的 agent loop。

这个 bundle 用无头的 `pi --mode rpc` 子进程替换 DSH 自带的 `dsh-agent-loop`。DSH 继续提供会话、Web UI、预设与权限界面；pi 继续使用自己的系统提示词、工具、压缩与模型路由。

## 支持的能力

- **流式输出、工具卡片、停止按钮**：把 pi 的 RPC 事件翻译成 DSH 的持久会话事件与 `agent/assistant-stream` 帧。
- **resume**：每次创建/恢复都从 DSH 事件日志重建 pi 会话文件，重启后的会话在 pi 侧保留完整上下文。
- **模型选择器**：插件读取 `pi --mode rpc get_available_models`，把 pi 自己的模型目录注册进 DSH 的 LLM 注册表；选择器里就是 pi 能跑的模型，选中后通过 `set_model` 下发。
- **转向与排队**：运行中的 `steer` 会转发给 pi，被接受后立即从队列中领取；`followup` 按顺序各自成轮。
- **可交还**：pi 驱动的会话能被内置 loop 继续，因为每次请求都按 DSH 标准事件记录（含声明工具表的 `request/header`）。

## 安装

要求：DSH `0.2.2-rc.1` 或兼容版本；`pi` 在 `PATH` 上（或显式指定 `piPath`）。

```sh
dsh plugin --profile web add github:Komorebi-Nine/dsh-inline-pi-agent
```

bundle 层会禁用 `agent-loop`、DSH 侧压缩与工具结果裁剪，并插入 `pi-agent` 行。之后重启 `dsh web`，或依赖 profile 的 patch 热重载。

本地检出安装：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-inline-pi-agent
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `piPath` | `pi` | pi 可执行文件。Windows 下可为 `.cmd`/`.exe` 路径或裸名（经 `cmd.exe` 解析）。 |
| `model` | 空 | 创建会话时推给 pi 的初始路由，如 `deepseek/deepseek-flash`。 |
| `models` | 空 | 两套目录命名不一致时的 DSH 路由 → pi 路由映射。 |
| `catalog` | `true` | 是否把 pi 的模型目录注册进 DSH（选择器据此显示）。 |
| `requestHeader` | `true` | 每步记录 `request/header` 与 `request/context`；token 计量与会话交还依赖它。 |
| `streamFlushMs` | `20` | 流式增量的合并窗口（5–200ms）。pi 每个 token 一个 delta，合并后浏览器才有可渲染的帧率。 |
| `streamFlushChars` | `1024` | 缓冲超过该字符数立即 flush，限制单条大小。 |
| `piSessionDir` | `~/.dsh/pi-sessions` | 重建的 pi 会话快照目录。 |
| `debug` | `false` | 协议与生命周期日志。 |

在自己的 profile patch 里覆盖：

```yaml
- id: pi-agent
  config:
    piPath: 'C:/Users/me/.pi/agent/bin/pi.cmd'
```

## 已知限制

- pi 自己执行工具，因此 DSH 的沙箱、审批与权限预设不作用于这些工具。
- 插件不派发 `agent/pre-step`，依赖它的钩子（时间注入、每步 flush、plan-mode 旁白）在 pi 会话中不生效。
- `contextBreakdown.toolsTokens` 描述的是 DSH 工具注册表而非 pi 的工具块（写在 `request/header` 上是为了让原生 loop 能续接）；上下文压力本身来自 provider 上报的 usage。

## 回退

在**设置 → 插件**里停用该 bundle，或移除包。bundle 层随之消失，`agent-loop` 恢复启用，已有会话可继续。

**停用/启用后请重启 `dsh web`。** 切换会替换唯一的 agent 工厂与 loop 的会话投影，运行中的 loader 无法原子完成这次替换；半应用的重载会让会话列表显示为空（数据仍在磁盘上，重启即恢复）。切换本身不会改动任何会话数据。

如果启用期间把部署默认模型改成了 pi 路由，停用前请改回内置路由——pi 的 provider 只在 bundle 加载期间存在：

```yaml
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }
```

## 开发

`CONTRACT.md` 记录了插件所依赖的接口、事件与协议契约，以及对应的实测数据。`scripts/smoke.mjs` 是独立测试台（不需要 DSH 服务器），覆盖 text / tool / multi / abort / dispose / resume / steer / followup / token / catalog：

```sh
node scripts/smoke.mjs text
node scripts/smoke.mjs tool
node scripts/smoke.mjs resume
```

## 许可

MIT，见 [LICENSE](LICENSE)。
