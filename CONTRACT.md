# dsh-pi-agent 对接契约清单

DSH `0.2.2-rc.1` ⇄ pi `1.5.0`。本文件只写"必须对齐的接口、字段、时序"，不写实现细节。
标注 `[待验证]` 的条目需要在 P0/P1 阶段用真实运行确认，不要按推测编码。

---

## 0. 范围

- 做什么：实现一个 `AgentFactory` + `Agent`，用 `pi --mode rpc` 子进程替换 `dsh-agent-loop`，由 pi 驱动 DSH 会话。
- 不做什么：不桥接工具（pi 用自己的 `read`/`bash`/`edit`/`write`）、不做按会话切换 loop、不改 DSH 前端。
- 交付形态：独立包，profile patch 里禁用 `agent-loop` 并插入本插件。

---

## 1. 版本基线

| 组件 | 版本 | 位置 |
|---|---|---|
| DSH | `0.2.2-rc.1` | `C:\Users\k\.dsh\profiles\node_modules\@deepseek-ai\*`（junction 到 `C:\Users\k\.bun\install\global\node_modules`） |
| pi | `1.5.0` | `C:\Users\k\.pi\agent\install\releases\1.5.0\node_modules\@earendil-works\pi-coding-agent` |
| Node | `v26.13.0` | pi SDK 要求 ≥ 22.19 |

peerDependencies（`^0.2.2-rc.1`）：

```
@deepseek-ai/cordis
@deepseek-ai/dsh-agent
@deepseek-ai/dsh-llm
@deepseek-ai/dsh-scope
@deepseek-ai/dsh-session
@deepseek-ai/dsh-session-persistence
@deepseek-ai/dsh-session-projection
```

---

## 2. 插件装配

包同时是 **bundle**：`package.json` 的 `dsh.bundle.patch` 指向自带的 `cordis.patch.yml`，所以安装即整层生效，profile 不需要手写任何行。

```powershell
dsh plugin --profile web add link:C:/Users/k/Documents/DSH/dsh-pi-agent
# 发布后：dsh plugin --profile web add dsh-pi-agent
```

安装器会把它自动登记进 `profiles/<name>/package.json` 的 `dsh.profile.bundles`（实测）：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-pi-agent"] } }
```

bundle 层内容（`cordis.patch.yml`，随包发布）：

```yaml
- id: agent-loop
  disabled: true          # 工厂唯一
- id: compaction-basic
  disabled: true          # pi 自己压缩
- id: command-compact
  disabled: true
- id: tool-result-pruner
  disabled: true
- insert:
    - id: pi-agent
      name: 'dsh-pi-agent'
      config: { piPath: 'pi', debug: false }
```

用户 patch（`cordis.patch.yml`）在 bundle 之后应用，仍可覆盖：

```yaml
- id: pi-agent
  config:
    piPath: 'C:/Users/k/.pi/agent/bin/pi.cmd'
    debug: true
```

`src/index.js` 仍是一个普通 Cordis 插件（`name` / `inject` / `apply`），bundle 只是把它和必要的行一起交付：

```ts
export const name = 'pi-agent'
export const inject = ['sessions', 'agents', 'sessionProjections', 'llm']
export async function apply(ctx: Context, config): Promise<void>
```

约束：

| 项 | 说明 |
|---|---|
| 工厂唯一性 | `ctx.agents.setFactory()` 在已有工厂时抛 `an agent factory is already registered`（`dsh-agent/lib/index.js`）。必须禁用 `agent-loop`，**不能**"底下还留一份" |
| 回退 | 禁用 bundle（或删掉行）；bundle 层撤销后 `agent-loop` 自动回到启用状态 |
| 服务依赖 | `agentLoop` 服务只有 `dsh-agent-loop` 自己声明，其他包不 `inject`，因此禁用不会连带失败 |

---

## 3. DSH 接口契约

### 3.1 AgentFactory（`@deepseek-ai/dsh-agent`）

```ts
createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
```

`CreateAgentOptions`：

| 字段 | 类型 | 处理方式 |
|---|---|---|
| `sessionId` | `SessionId` | 唯一身份，直接给 `sessions.prepare` 与 pi session 文件命名 |
| `parentAgent?` | `Agent` | 传给 `ctx.agents.enter(agent, parentAgent)` |
| `meta?` | `{ cwd?, parentSession?, isSeeded?, origin?: 'subagent', delegationDepth?, agentPreset? }` | 原样传给 `sessions.prepare(id, { meta })`；`cwd` 必须绝对路径 |
| `inheritedEventCount?` | `SessionLogOffset` | fork 场景，P0 不处理，直接透传 |
| `seed?` | `SessionEvent[]` | fork 场景，P0 不处理，直接透传 |
| `agentOptions?` | `AgentOptions` | 初始路由；`provider` / `model` / `reasoningEffort` / `maxTokens` |
| `signal?` | `AbortSignal` | 创建期取消；abort 后必须回滚已建资源再 reject |
| `setup?` | `AgentSetup` | **签名已变更**：`(agentCtx, agent)`，且可能返回 `{ commit() }`；必须在发布前 await，commit 在发布前同步调用 |

`ResumeAgentOptions`：`resumeSessionId` / `parentAgent?` / `agentOptions?` / `signal?` / `setup?`。

`AgentHandle`：`{ agent, dispose(): Promise<void> }`；`dispose()` 需完成"停 pi → 注销 agent/session → 解 scope → 关写句柄"。

### 3.2 Agent 必填成员

```ts
readonly id: SessionId
readonly options: AgentOptions
readonly session: Session
readonly model: Model              // AgentModel
readonly inbox: Inbox
readonly status: AgentStatus       // 'idle' | 'running'
readonly ctx: Context              // createScope(...).ctx.extend({ agent })
cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void
whenIdle(): Promise<void>
runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void
followup(message: UserMessage): void
steer(message: UserMessage): void
inject(message: UserMessage): void
```

`Inbox` 必须实现：`nextTurn` / `nextStep` / `clear()` / `append()` / `prepend()` / `replace()` / `remove()` / `splice()`。
**0.2.2 不再从 `dsh-agent` 导出 `Inbox` 类**，需自研；每次变更都要追加 `agent/inbox/spliced` 并发出对应 `agent/inbox/*` 通知。

`AgentCancelCause`：`{kind:'user'}` | `{kind:'parent'}` | `{kind:'hook',reason}` | `{kind:'disposed'}`。

### 3.3 配套 API

| 用途 | API | 出处 |
|---|---|---|
| 建会话 | `ctx.sessions.prepare(id, { meta, seed })` → `enter(session)` → `announce(session)` | `dsh-session/index.d.ts:442-478` |
| 持久化写句柄 | `ctx.sessionPersistence.create(header)` / `open(id, 'write')` → `close()` | `dsh-session-persistence/handle.d.ts` |
| scope | `createScope(ctx, key)`；key 用 agent 对象自身 | `dsh-scope/index.d.ts:78` |
| 事件分发 | `agentEvents(ctx, agent)` → `emit/serial/waterfall`；一次性通知用 `emitAgentEvent(ctx, agent, name, payload)` | `dsh-agent/dispatch` |
| 模型选择 | `readerFor(session)` + `modelSelectionProjectionDefinition` + `new AgentModel(readState, session, options)` | `dsh-session-projection`、`dsh-agent/model-selection` |
| 消息构造 | `createAssistantMessage` / `createToolResultMessage` / `CallId` | `dsh-llm/message` |

---

## 4. 持久事件契约（必须由 loop 追加）

| 事件 | 字段 | 约束 |
|---|---|---|
| `turn/start` | `{turn}` | 每轮一次 |
| `step/start` / `step/end` | `{turn,step}` | 一次模型调用 + 其工具执行 = 一个 step |
| `user/message` | `UserMessage` | `surfaceOp:'append'`；`id`/`content`/`source` 必填 |
| `assistant/message` | `{turn, step, message, stream, usage?, interrupted?}` | **`stream: AssistantStreamRecord[]` 必填**；`sourceEventSeqs` 对本事件非法（用 `stream` 内嵌） |
| `assistant/attempt` | `{turn, step, stream}` | 失败/重试/中断且不产生可见消息时用 |
| `tool/call` | `{turn, step, callId, name, arguments}` | `arguments` 是模型产出的原始 JSON 字符串 |
| `tool/result` | `{turn, step, message, error?, meta?}` | `surfaceOp:'append'`，`sourceEventSeqs:[tool/call.seq]` |
| `turn/end` | `{turn, reason}` | `TurnEndReason`：`completed`/`aborted{reason}`/`blocked`/`error{error}`/`max-tokens`/`interrupted`/`forked` |
| `model/selection` | `ModelSelection` | 由 `AgentModel.select()` 产生，不要手写 |

禁止事项：

- `assistant/chunk` 在 0.2.2 **已不存在**，追加会被判为未知事件。
- 自造事件类型必须带 `ignorable` 标记，否则持久化读路径拒绝加载整个日志。
- `assistant/message` 的 `stream` 不是可选字段，缺失等同于数据损坏。

---

## 5. 实时事件契约（`agent/*`，进程本地）

| 事件 | payload | 何时发 |
|---|---|---|
| `agent/status` | `{status}` | 状态切换；构造时发一次 `idle` |
| `agent/session-start` | `{source:'startup'}` | 发布完成后一次 |
| `agent/assistant-stream` | `AssistantStreamFrame`：`start{attemptId,revision,turn,step}` / `chunk{attemptId,revision,index,time,chunk}` / `end{attemptId,revision,index,outcome}` | **Web 端逐字输出的唯一来源**；消费方是 `dsh-api-session-controller` |
| `agent/error` | `{turn, step, error}` | step 内异常 |
| `agent/inbox/inserted` | `{message}` | 每次 inbox 插入 |
| `agent/inbox/claimed` | `{message, turn}` | 轮次/步骤边界领取 |
| `agent/inbox/discarded` | `{message}` | 取消清空 |

`agent/created` / `agent/disposed` 由 `ctx.agents.enter/announce` 与 teardown 产生，不要手工发。

---

## 6. pi 侧协议

### 6.1 启动

```
pi --mode rpc --session <file.jsonl>     # 有历史
pi --mode rpc --no-session               # 无历史
```

Windows：`pi` 是 `pi.cmd` / `pi.ps1`，`spawn('pi')` 不可直接执行，需 `pi.cmd` + `shell` 或 `cmd.exe /c`。
pi 需要写 `~/.pi`（配置、信任、session），沙箱化环境下会 EPERM。

### 6.2 用到的命令

| 命令 | 字段 | 响应 |
|---|---|---|
| `prompt` | `{message, images?, streamingBehavior?: 'steer'\|'followUp'}` | `data.disposition`: `started`/`queued`/`handled`；`handled` 时不要等 `agent_settled` |
| `steer` | `{message, images?}` | 运行中插入，落在下一次 LLM 调用前 |
| `abort` | `{}` | 结束后才回响应 |
| `set_model` | `{provider, modelId}` | 返回完整 Model 对象 |
| `get_available_models` | `{}` | `data.models[]`，用于模型映射校验 |

所有命令都可带 `id`，响应同 `id`；事件一般无 `id`。

### 6.3 用到的事件（字段已实测）

| 事件 | 字段 |
|---|---|
| `message_start` | `message`；assistant 首帧 `content:[]`、`stopReason:'pending'`、`usage` 全 0 |
| `message_update` | `usage`（累计，流式期间可能为 0）+ `assistantMessageEvent{type, contentIndex, delta?/content?}` |
| `message_end` | `message`（权威完整消息，含 `usage`、`stopReason`、`durationMs`、`thinkingLevel`） |
| `tool_execution_start` | `toolCallId`, `toolName`, `args`（**对象，不是字符串**） |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult` |
| `tool_execution_end` | `toolCallId`, `toolName`, `result{content[], structuredContent?}`, `isError`, `durationMs` |
| `turn_start` / `turn_end` | `turn_end` 带 `message`, `toolResults[]` |
| `agent_start` / `agent_end` / `agent_settled` | `agent_end` 带 `messages[]`,`willRetry`；`agent_settled` 带 `aborted` |

关键语义（实测）：

- `message_start/message_end` **不只属于 assistant**：system 提示词、user 消息、工具结果都会各发一对，必须按 `message.role` 过滤。
- 工具结果消息的 role 是 **`toolResult`**（驼峰），字段 `toolCallId`/`toolName`/`content`/`isError`/`durationMs`。
- `message_update` 只带 delta；`text_end`/`thinking_end` 才给权威全文，`message_end` 覆盖整条消息。
- `stopReason`：`pending` / `stop` / `toolUse` / **`aborted`**（中断时仍保留已产出的部分内容）。
- 以 `agent_settled` 作为 DSH 轮次结束信号；`agent_end` 后仍可能有重试/压缩/排队工作。
- **run 进行中不能关 stdin**：stdin EOF 触发有序关闭并中止当前 run（实测只收到 system/user 两个消息对就退出）。

内容块映射：pi `text`→DSH `text`、`thinking`→`reasoning`、`toolCall`→`tool-call`（`arguments` 对象需 `JSON.stringify`）。

`usage` 字段映射（pi → DSH `TokenUsage`）：

| pi | DSH |
|---|---|
| `input` | `inputTokens` |
| `output` | `outputTokens` |
| `cacheRead` | `cacheReadTokens` |
| `cacheWrite` | `cacheWriteTokens` |
| `reasoning` | `reasoningTokens` |
| `totalTokens` | `totalTokens` |
| `cost` | 丢弃（DSH 无对应字段） |

---

## 7. 映射表

**轮次粒度（实测修正）**：pi 的 `turn_start`/`turn_end` 是"一次 assistant 响应 + 它的工具调用"，**不是**用户一轮对话。
因此映射为：

| pi | DSH |
|---|---|
| `agent_start` | `turn/start`（一个用户提示 = 一个 DSH 轮） |
| `turn_start` | `step/start` |
| `message_start`（assistant） | assistant 消息起点；如有 prior step 则其 `turn_end` 已关闭 step |
| `message_update.text_delta` | `agent/assistant-stream` chunk（`text-delta`）+ 累积 `AssistantStreamRecord` |
| `message_update.thinking_delta` | 同上（`reasoning-delta`） |
| `message_update.toolcall_delta` | 同上（`tool-call-delta`） |
| `message_update.*_start/_end` | 只用于切分内容块，不直接落事件 |
| `message_end`（assistant） | `assistant/message`（含 `stream`、`usage`）→ 发 `assistant-stream end{committed}` |
| `tool_execution_start` | `tool/call`（`arguments` 用 `JSON.stringify(args)`），记 `seq` 备关联 |
| `tool_execution_end` | `tool/result`（`content` 取 `result.content`，`isError` 直传），`sourceEventSeqs:[callSeq]` |
| `turn_end` | `step/end` |
| `agent_settled{aborted:false}` | `turn/end{completed}` |
| `agent_settled{aborted:true}` | `turn/end{aborted, reason}`；已产出文本以 `interrupted:true` 落 `assistant/message` |
| `message_end`（user / toolResult / system） | 不落事件（DSH 侧由 loop 自己写 `user/message`、`tool/result`） |

中断实测行为：`abort` 在 run 中到达后，pi 发 `message_end{stopReason:'aborted'}`（保留部分内容）→ `turn_end` → `agent_end{willRetry:false}` → `agent_settled{aborted:true}` → 最后才回 `abort` 的 `response`。所以 DSH 侧不能等 `abort` 响应来判断停稳，要等 `agent_settled`。

---

## 8. 生命周期时序

**create**

```
createAgent(ownerCtx, opts)
  ├─ persistence.create(header)              // 拿写句柄
  ├─ sessions.prepare(sessionId, {meta, seed})
  ├─ buildPiSessionFile(session) → ~/.dsh/pi-sessions/<id>.jsonl
  ├─ spawn pi --mode rpc --session <file>
  ├─ new PiAgent(...)                        // scope + agentEvents + Inbox
  ├─ await setup(agent.ctx, agent) → commit()
  ├─ sessions.enter(session) / announce(session)
  ├─ agents.enter(agent, parent) / announce(agent)
  └─ emit agent/session-start
```

**turn**（一个用户提示 = 一个 DSH turn；pi 的每个 turn 对应一个 DSH step）

```
turn/start
  └─ user/message → prompt 命令
       ├─ pi agent_start
       ├─ pi turn_start            → step/start
       │    message_start/update…  → assistant-stream 帧
       │    message_end            → assistant/message
       │    tool_execution_start   → tool/call
       │    tool_execution_end     → tool/result
       │  pi turn_end              → step/end
       ├─ pi turn_start …（工具后续步骤重复）
       ├─ pi agent_end
       └─ pi agent_settled         → turn/end{completed | aborted}
```

**resume**

```
persistence.open(id,'write') → read() → fold inbox/model 投影 →
prepare(session with seed) → rebuild pi session file → spawn → 发布
```

**dispose**：`abort pi` → `close()` pi 子进程 → 关闭 step/turn（若开着）→ `agent/disposed` → 解 scope → `handle.close()`。

---

## 9. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `piPath` | `pi` | Windows 建议显式给 `pi.cmd` 绝对路径 |
| `cwd` | `process.cwd()` | 兜底工作目录；`meta.cwd`（会话工作区）优先 |
| `model` | 空 | 创建会话时推给 pi 的初始路由；空则用会话路由 / pi 默认 |
| `models` | 空 | DSH 路由 → pi 路由的映射表；目录对齐（见 §9.4）后一般不需要 |
| `catalog` | `true` | 启动时探测 pi 并注册模型目录适配器；`false` 关闭 |
| `requestHeader` | `true` | 每步记录 `request/header` + `request/context`（token 计量需要）；`false` 关闭 |
| `piSessionDir` | `~/.dsh/pi-sessions` | 重建的 pi 会话快照目录 |
| `debug` | `false` | 协议与生命周期日志 |

### 9.0 profile 必需行

前四行已由 bundle 层自带（见 §2）。仅当**不用 bundle**、手工挂行时才需要自己写：

```yaml
- id: agent-loop
  disabled: true          # 工厂唯一
- id: compaction-basic
  disabled: true          # pi 自己压缩
- id: command-compact
  disabled: true
- id: tool-result-pruner
  disabled: true          # 会改日志 surface，resume 回放给 pi 时失真
- insert:
    - id: pi-agent
      name: 'dsh-pi-agent'
```

默认模型建议指向 pi 路由（目录适配器已注册同名 provider）：

```yaml
- id: agent-default-model
  config: { provider: deepseek, model: deepseek-flash }
```

---

## 9.1 实测记录（pi 1.5.0，2026-11-07）

隔离环境：`PI_CODING_AGENT_DIR` 指向临时目录并从 `~/.pi/agent` 复制凭据，cwd 指向临时工作区；`pi --mode rpc --no-session`，用 `cmd` 管道喂命令。

| 场景 | 观测到的序列 |
|---|---|
| 纯文本一轮 | `response(prompt, started)` → `agent_start` → `turn_start` → `message_start/end`(system) → `message_start/end`(user) → `message_start`(assistant) → 4×`message_update` → `message_end` → `turn_end` → `agent_end` → `agent_settled{aborted:false}` |
| 带工具 | … `message_end`(assistant, `stopReason:'toolUse'`, content=`[toolCall]`) → `tool_execution_start` → `tool_execution_end` → `message_start/end`(`role:'toolResult'`) → `turn_end` → `turn_start`(下一步) → … |
| 中断 | `message_end{stopReason:'aborted'}`（保留 1083 字符）→ `turn_end` → `agent_end{willRetry:false}` → `agent_settled{aborted:true}` → `response(abort)` |
| 空 stdin | 仅 system/user 消息对后进程退出，run 被中止 |

其它确认：

- Windows 下 `pi.cmd` + `cmd /c` 重定向可用，stdout 为纯 JSONL，无 banner 干扰；`--no-session` 全程无 stderr。
- `get_state.data` 字段：`model`、`thinkingLevel`、`isStreaming`、`isCompacting`、`steeringMode`、`followUpMode`、`sessionId`、`autoCompactionEnabled`、`messageCount`、`pendingMessageCount`。
- `set_model`：成功返回完整 Model 对象；失败为 `success:false, error:"Model not found: <provider>/<model>"`（provider 或 model 任一不存在都是这句）。
- `message_update` 子类型实测出现：`thinking_start/delta/end`、`text_start/delta/end`、`toolcall_start/delta/end`。
- `agent_settled` 是唯一可靠的"停稳"信号；`abort` 的响应在停稳之后才回。

## 9.2 P0 实测记录（插件首版，2026-11-07）

测试方式：`scripts/smoke.mjs` 直接启动最小服务组合（TypertRegistry + SessionProjectionRegistry + SessionStore + AgentRegistry + 本插件），不启动 DSH 服务器。

| 场景 | 结果 |
|---|---|
| 纯文本一轮 | `turn/start` → `user/message` → `step/start` → `assistant/message` → `step/end` → `turn/end{completed}`；stream 4 条 raw chunk；usage 正确映射 |
| 工具调用 | 1 个 turn、**2 个 step**；`tool/call` → `tool/result`（`sourceEventSeqs=[6]` 指向对应 call）；第二次 assistant 消息落在 step 2 |
| 两轮对话 | turn 1/2 独立，inbox `inserted → claimed` 各一次，pi 侧上下文连续 |
| 中途取消 | `turn/end{aborted, reason:{kind:'user'}}`，assistant 消息标 `interrupted:true` |
| 实时帧 | `assistant-stream` 每次尝试 1 个 start + N 个 chunk + 1 个 end；end 的 `outcome` 带 durable seq |
| 无持久化 | 会话只存在内存（写句柄 / resume 属 P2） |

实现取舍（与 §10 待验证项相关）：

- `AssistantStreamRecord` 统一使用 raw `chunk` 记录（`{type:'chunk', time, chunk}`），不实现 delta 打包；因此 `tool-call-chunks` 变体无需解析。
- Windows 下通过 `cmd.exe /d /s /c` 单行命令启动 `pi.cmd`，不再使用 `shell:true` + args（会触发 DEP0190 且可能重新分词）。
- pi 子进程退出会立即释放等待中的 settle，避免 `whenIdle()` 悬死。

## 9.3 P2 实测记录（持久化 + resume，2026-11-07）

测试方式：冒烟脚本挂载 `@deepseek-ai/dsh-session-persistence-jsonl`（`root` 指向临时目录），先建会话、跑一轮、dispose，再 `agents.resume()` 续接。

| 检查点 | 结果 |
|---|---|
| 写句柄 | `persistence.create(header)` → `appendUnstoredSuffix` → 进入 store 后按会话 id 路由；teardown 时 `handle.close()` |
| 落盘 | 日志文件生成；关闭时后端追加 `session/end-seed` 作为种子边界 |
| resume 读路径 | `open(id,'write')` → `read(0)` → `interruptedTurnClosers` → `prepare(seed)` |
| 历史重建 | 生成 pi v3 会话文件（header + `message` 条目链）；pi 续接后能答出上一轮内容（"42"） |
| 轮次编号 | 续接后 `turn` 从 2 继续（`agents.turnBoundaryOf(session).lastTurn`） |
| 事件连续性 | 续接事件接在既有 seq 之后（8→16），无重复、无空洞 |

踩到并修掉的两个真问题：

1. **pi 要求 assistant 消息带 `usage`**：缺 `usage.input` 会让 pi 在重建上下文时抛 `Cannot read properties of undefined (reading 'input')`。已把 DSH `TokenUsage` 反向映射为 pi 的 `{input, output, cacheRead, cacheWrite, totalTokens, cost}`。
2. **轮次号必须从持久化状态恢复**：否则续接后 `turn` 回到 1，与历史 `turn/start` 冲突。

未覆盖：崩溃恢复（日志末尾 turn 未闭合 → `interruptedTurnClosers` 合成收尾）、resume 时 pending inbox 的折叠（正常 dispose 会清空待处理输入，只有崩溃残留才会走到）。

## 9.4 模型目录接入（2026-11-08）

浏览器模型选择器读的是 `ctx.llm.listProviders()` / `listModels()`（`dsh-api-session-controller` 的 `buildModelCatalog`）。

接入方式：插件启动时用一次性 `pi --mode rpc` 子进程调 `get_available_models`，再用一个 **catalog-only** 的 `LlmAdapter` 把 pi 的模型注册进 `ctx.llm`——provider 名与 model id 都是 pi 自己的，因此：

- 会话路由 = pi 路由，选择即直通，无需映射表；
- `resolveModel` 提供 `contextWindow`、`maxTokens` 与推理档位（来自 `thinkingLevelMap`），选择器可显示上下文与思考等级；
- `stream()` 直接抛错：pi 才是执行者。任何走 DSH LLM 的同路由功能（压缩、标题）都必须关掉或另配路由。

实测（`pi` 1.5.0）：

```
deepseek (pi · deepseek): deepseek-flash, deepseek-v4-pro
  resolve deepseek-flash: context=512000 efforts=low|high|max
opencode-go (pi · opencode-go): claude-haiku-5-5, minimax-m3, … (30+)
```

适配器必须最先注册（早于工厂发布），否则前端可能在目录就绪前渲染选择器。

## 9.5 转向 / 排队 / 双向兼容 / token 修正（2026-11-08）

### steer 与 followup

| 场景 | 观测 |
|---|---|
| 运行中 `steer` | `next-step` 插入 → pi 接受后立即 claim（纯删除）→ 当前 assistant 轮结束后产生新的 assistant 消息 `STEERED`；不会在下一轮重复拼进 prompt |
| `followup` 连发两次 | 严格 FIFO：turn 1 = FIRST，turn 2 = SECOND |

实现要点：`steer` 在运行中把文本转给 pi，并在 `rpc.steer` 成功后调 `inbox.claimMessage()`；失败则留在 inbox，下一轮作为 prompt 前缀投递。早期实现只转给 pi 而不 claim，会导致下一轮重复投递。

### 与原生 loop 的双向兼容

| 会话来源 | 原生 loop 续接结果 |
|---|---|
| pi 会话，**无** `request/header` | 正常续接并答出上文暗号 |
| pi 会话，header **无 tools** | ❌ 被 DeepSeek 拒绝：`tools: at least one tool must have defer_loading=false`（原生 loop 把全部工具当新增 → 全部 deferred） |
| pi 会话，header **声明 DSH 工具表** | ✅ 正常续接（实测答出 `NOVA-3`）；原生 loop 重新记录自己的 `resume` header |

因此 `request/header` 必须带上 DSH 工具注册表的 schema（`ctx.tools.schemas()`），即使 pi 并不使用这些工具。代价：`contextBreakdown.toolsTokens` 反映的是 DSH 工具集而非 pi 的实际工具块；上下文压力仍以 provider usage 为准，不受影响。

### token 计量

根因：`tokenMeasurement` 只在存在 `request/header` 时采用 provider 上报的 usage，否则退化为启发式估算。

修正后（单次调用实测）：

| 指标 | 值 |
|---|---|
| `ttftMs` | 1146 |
| `decodeMs` | 25 |
| `decodeTokens` | 4 |
| `tokenUsage` | `uncachedInput 148 / output 4 / cacheRead 7296` |

同时记录 `request/context`（provider、model、`contextWindow`），供上下文压力展示使用。

## 9.6 剩余项处理（2026-11-08）

| 项 | 结论 |
|---|---|
| 空 `stream` | ✅ 接受：`assistant/message` 带 `stream: []` 可入库，投影正常折叠 |
| 非绝对 `cwd` | ✅ `session header cwd must be an absolute path, got "relative/path"` |
| 流式中 `dispose` | ✅ 事件闭合（`step/end` + `turn/end`）；工具执行中中断不产生孤儿 `tool/call`；代价是可能留下一个空 step |
| `requestHeader: false` | `sessionStats` 指标仍可用（ttft 1078ms vs 开头的 1146ms），但 `tokenMeasurement.anchor.usage` 为空 → 上下文占用采样退回估算 |
| `agent/pre-step` 缺失 | ⚠️ 确认是 **waterfall**（`next()`）；pi 模式下这些不生效：`dsh-time-context`（时间注入）、`dsh-agent-instructions`（AGENTS.md 组合）、`dsh-plan-mode`（旁白/闸门）、`dsh-session-checkpoint-policy`（每步 flush）。**决定不实现**：pi 自带上下文加载，DSH 再注入会重复；如需启用应做成显式 opt-in |

## 9.7 安装、开关与热更新（2026-11-08 核实）

安装（bundle 形式，实测）：

```powershell
dsh plugin --profile web add link:C:/Users/k/Documents/DSH/dsh-pi-agent
```

装完 `profiles/web/package.json` 的 `dsh.profile.bundles` 会自动多出 `dsh-pi-agent`；只装这一个包就能启动并跑出结果（临时 profile 实测输出 `BUNDLE_OK`），无需手写 patch。

开关：

| 层 | 机制 | 效果 |
|---|---|---|
| bundle | 设置 → 插件 → 该 bundle 的开关（`plugin-manager.setBundleEnabled` → `selectBundle`） | 整层撤销/恢复；撤销后 `agent-loop` 自动回到启用 |
| 单行 | `setPluginEnabled(id, enabled)`，把 `disabled` 写进 profile patch（保留注释） | 逐行；本插件不建议单独关 `pi-agent`，否则没有工厂 |
| 手工 | 直接编辑 profile patch | 等价 |

热更新：

| 改动 | 是否热生效 |
|---|---|
| patch / bundle 增删行（web 这类长驻 surface） | ✅ `plugin-manager.reload()` → `hmr.reconcileProfile()` |
| headless 等 startup-only profile | ❌ 需重启（`hmr` 未挂载时 `reload()` 只重新组合配置） |
| 本包**代码**改动 | ❌ `hmr.root` 为空，不监听包目录；需重启（或把包路径加进 `hmr.root`） |
| `link:` 目标 / 版本等解析变化 | ❌ 明确 `ResolutionRestartRequired` |

注意：对已安装过的包再次执行 `dsh plugin add` 只会 `Already up to date`，不会补登记 bundle（安装器只扫描新增依赖）；需要 `remove` 后重装，或用 bundle 开关。

## 10. 待验证（剩余）

无阻塞项。可选后续：

1. `agent/pre-step` 的显式 opt-in（接受重复注入风险时）。
2. 流式中 dispose 的空 step 是否要在 UI 侧过滤。
3. `hmr.root` 纳入本包路径，实现插件代码热更新。

---

## 11. 验收清单

- [x] 新建会话一轮问答，session JSONL 含 `turn/start`→`user/message`→`step/start`→`assistant/message`→`step/end`→`turn/end`
- [x] 一次用户提示触发多步（工具）时，DSH 侧是 1 个 turn、N 个 step（对齐 pi 的 `agent_*` / `turn_*` 粒度）
- [x] Web 端逐字输出（`revision` 逐帧递增后已确认流式）
- [x] 一次工具调用在 UI 上呈现为 call + result 两块，且 `sourceEventSeqs` 关联正确
- [x] 中途停止：`turn/end{aborted}`，已输出文本保留为 `interrupted:true`
- [x] run 进行中不关闭 pi 的 stdin（`close()` 先 abort 再 end）
- [x] 转向（steer）在运行中生效，落在当前工具批次之后（并即时 claim，不重复投递）
- [x] followup 连发保持 FIFO，各自独立成 turn
- [x] 模型选择器显示 pi 模型并可切换（目录适配器 + `set_model` 转发）
- [x] token 计量采用 provider usage（`request/header` + `request/context`）
- [x] 关闭 DSH 后重新打开并 resume：pi 侧上下文完整（已用独立进程验证，跨 DSH 重启待 P4）
- [x] 在 pi 下跑过几轮再切回原生 loop 的会话可正常续接（header 需声明 DSH 工具表）
- [x] 无 `assistant/chunk`、无未知事件，日志可被持久化读路径正常加载
- [x] Windows 下 `piPath` 生效，无 EPERM（经 `cmd.exe /d /s /c` 启动 `pi.cmd`）
