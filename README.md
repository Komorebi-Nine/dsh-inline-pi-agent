# dsh-inline-pi-agent

Run the [pi coding agent](https://github.com/earendil-works/pi) loop inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The bundle replaces DSH's agent loop (`dsh-agent-loop`) with a headless `pi --mode rpc` child process. DSH keeps its sessions, web UI, presets and permission surface; pi keeps its own prompt, tools, compaction and model routing.

## What works

- **Streaming, tool cards, stop button** — translated from pi's RPC events into DSH's durable session events plus `agent/assistant-stream` frames.
- **Resume** — on every create/resume the pi session file is rebuilt from DSH's event log, so a restarted harness continues with the full conversation in pi's context.
- **Model selector** — the plugin reads `pi --mode rpc get_available_models` and registers pi's own catalog in DSH's LLM registry. The selector lists exactly the models pi can run, and a selection is forwarded with `set_model`.
- **Steering and follow-ups** — `steer` is forwarded to pi mid-run and claimed once accepted; queued follow-ups run as separate turns in order.
- **Hand-back** — a session driven by pi can be resumed by the built-in loop, because every request is recorded in DSH's standard event vocabulary (including a `request/header` that declares the registry's tool schemas).

## Install

Requirements: DSH `0.2.2-rc.1` or a compatible release, and `pi` on `PATH` (or an explicit `piPath`).

```sh
dsh plugin --profile web add github:Komorebi-Nine/dsh-inline-pi-agent
```

The bundle layer disables `agent-loop`, DSH-side compaction and tool-result pruning, then inserts the `pi-agent` row. Restart `dsh web`, or rely on the profile's patch reload.

Installing from a local checkout instead:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-inline-pi-agent
```

## Configuration

| key | default | meaning |
|---|---|---|
| `piPath` | `pi` | pi executable. On Windows, a `.cmd`/`.exe` path or a bare name (resolved through `cmd.exe`). |
| `model` | empty | Initial route pushed to pi, e.g. `deepseek/deepseek-flash`. |
| `models` | empty | DSH route → pi route mapping, when the two catalogs use different names. |
| `catalog` | `true` | Register pi's model catalog into DSH so the selector lists pi's models. |
| `requestHeader` | `true` | Record `request/header` and `request/context` per step. Needed for token measurement and for handing a session back to the built-in loop. |
| `piSessionDir` | `~/.dsh/pi-sessions` | Where rebuilt pi session snapshots are written. |
| `debug` | `false` | Protocol and lifecycle diagnostics. |

Override any of them in your profile patch:

```yaml
- id: pi-agent
  config:
    piPath: 'C:/Users/me/.pi/agent/bin/pi.cmd'
```

## Known limitations

- pi executes its own tools, so DSH sandboxing, approval flow and permission presets do not apply to them.
- The plugin does not dispatch `agent/pre-step`. Hooks that rely on it — time-context injection, the per-step flush, plan-mode narration — do not run for pi sessions.
- `contextBreakdown.toolsTokens` describes DSH's tool registry rather than pi's tool block; it is declared on `request/header` so a native-loop resume stays valid. Context pressure itself comes from provider-reported usage.

## Rollback

Disable the bundle under **Settings → Plugins**, or remove the package. The bundle layer disappears with it, so `agent-loop` is enabled again and existing sessions continue under the built-in loop.

**Restart `dsh web` after toggling the bundle.** Switching it on or off replaces the single agent factory and the loop's session projections. A running loader cannot apply that swap atomically; a half-applied reload can show an empty session list even though every session is intact on disk. A restart always restores them. Session data is never touched by the toggle.

If you also changed the deployment default model to a pi route while the bundle was active, set it back to a built-in route before disabling — pi providers only exist while the bundle is loaded:

```yaml
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }
```

## Development

`CONTRACT.md` records the interface, event and protocol contracts the plugin is built against, together with the measurements behind them. `scripts/smoke.mjs` is a standalone harness (no DSH server) covering text, tool, multi-turn, abort, dispose, resume, steer, followup, token accounting and the model catalog:

```sh
node scripts/smoke.mjs text
node scripts/smoke.mjs tool
node scripts/smoke.mjs resume
```

## License

MIT — see [LICENSE](LICENSE).
