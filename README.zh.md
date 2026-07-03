# opencode-fusion

[English](README.md)

一个 [OpenCode](https://opencode.ai) 插件。贵的模型做决策，便宜的模型干活，第三个模型独立审查。

如果你用的是 Codex 而不是 OpenCode，看 [codex-fusion](https://github.com/faceair/codex-fusion)。

灵感来自 Cognition 的 [Devin Fusion](https://cognition.com/blog/devin-fusion)，sidekick 架构来自他们。

## 安装

将 npm 插件添加到 OpenCode 配置（`~/.config/opencode/opencode.jsonc`）：

```jsonc
{
  "plugin": [
    [
      "@faceair/opencode-fusion",
      {
        "sidekick": {
          "model": "provider/model-name",
          "variant": "medium"
        },
        "reviewer": {
          "model": "provider/model-name"
        }
      }
    ]
  ],
  "default_agent": "fusion"
}
```

保存后重启 OpenCode。OpenCode 会在启动时自动安装 npm 插件。

设置后台 subagent 环境变量（启用并行调查模式）：

```sh
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
```

加到 shell 配置里（如 `~/.config/fish/config.fish` 或 `~/.bashrc`），确保每次启动都生效。

| 选项 | 适用 agent | 说明 |
|------|-----------|------|
| `model` | sidekick, reviewer | 模型，格式为 `provider/model-id` |
| `variant` | sidekick, reviewer | 推理强度（`low`、`medium`、`high`、`xhigh`） |
| `options` | sidekick, reviewer | provider 特定选项 |

如果省略 `model`，agent 继承当前会话的模型。如果不想把 Fusion 设为默认 agent，可以省略 `default_agent`，需要时手动选择 `fusion` agent。

## 它解决什么

用单模型 agent 做工程任务，几个常见问题：

- 贵模型的时间花在跑测试、读文件上，浪费钱。全换成便宜模型，决策质量又不够。Cognition 的数据显示 sidekick 架构在保持前沿模型表现的同时降低 35% 成本；测试套件委托给 sidekick 能省 62%，机械移除类任务省 32%。
- 一个模型写代码、审代码、批准代码，没有独立视角，容易漏掉边界情况。
- "问另一个模型"类工具每次跨模型调用都丢掉上下文缓存，得重新付一遍完整 prompt 的费用。长任务里这笔账涨得很快。
- 长任务做到一半停下来等你打"继续"。goal 会自动续跑，直到目标完成或明确阻塞。
- 上下文压缩后丢掉之前的工作记忆。goal 持久化到磁盘，能扛住进程重启；subagent `task_id` 在压缩后恢复。

## 怎么工作

两个并行 agent，各自有独立的工具和缓存上下文。主 agent 决定哪些活交给 sidekick，哪些自己做：

![Sidekick 架构：主 agent 和 sidekick 并行运行，各自保持缓存上下文](https://cognition.com/_next/static/media/sidekick-diagram.153unbtaywtzg.png)

opencode-fusion 在此基础上加了第三个只读 agent（reviewer）做独立审查，加上 goal 模式保持任务持续推进。三个 agent，各自独立的模型和上下文：

```
┌─────────────────────────────────────────────────┐
│  fusion（贵模型）                                │
│  负责：决策、最终审查、goal                       │
│                                                 │
│  通过 task() 委托 ────────────────┐              │
│  通过 task() 咨询 ────────────┐   │              │
│                               ▼   ▼              │
│                   ┌──────────────┐ ┌─────────┐   │
│                   │ reviewer     │ │ sidekick│   │
│                   │（只读）       │ │（便宜） │   │
│                   │ 风险审查      │ │ 执行    │   │
│                   │ + 对抗式审查  │ │ 发现    │   │
│                   │              │ │ 验证    │   │
│                   └──────────────┘ └─────────┘   │
└─────────────────────────────────────────────────┘
```

**fusion** 是你对话的主 agent。它只做最少必要的操作——读该读的，做该做的判断，其余默认委托和监控。它负责理解需求、做决策、把控交付质量，自己做最终审查，不替 sidekick 干活。

**sidekick** 干机械活：读代码、改文件、跑测试、定位失败。它把可定位的证据和观察返回给 fusion，不替 fusion 做结论。

**reviewer** 只读不改。在实现前审查高风险变更，在交付前做独立 code review。对涉及不可信输入、持久化、并发的变更，它从攻击者视角走一遍每个输入路径。

sidekick 和 reviewer 各自保持持久缓存上下文。委托不触发 cache miss——这是跟"问另一个模型"工具的关键区别。fusion 用 `task` 工具调用它们，拿到 `task_id` 后在后续调用中复用，继续同一个线程。

### 什么时候派 sidekick

不是整个任务选一个模型的路由器。fusion 逐步判断每一步该谁做：

- 慢验证交出去。sidekick 跑测试套件的时候，fusion 同时去做下一个决策。
- 判断密集的活收回来。sidekick 撞到 API 形状、错误语义、跨模块边界这种决策点，fusion 接手，不让便宜模型猜。
- 定向跟进。sidekick 发现意外情况，fusion 发一个聚焦的问题回去，而不是自己重新读代码。
- 判断本身就是交付物时，别委托。需要微妙意图判断的硬功能（比如跨团队搜索的 UI 决策），委托给便宜模型会丢掉意图，做出来不对。

### 什么时候找 reviewer

两种场景：

**实现前**，变更属于高风险时找 reviewer：共享 API 契约、跨子系统边界、生命周期/并发/持久化语义、安全/凭据/隐私、生产关键路径、同一方案反复失败、本地验证后信心仍不足。

**交付前**，任何非平凡变更都找 reviewer 做一轮 code review：正确性、完整性、回归、架构一致性。高风险变更还会做对抗式审查——从攻击者视角探测 diff：

- 输入是 50MB 而不是 5KB 会怎样？
- 时间戳来自未来会怎样？
- 后台 worker 执行到一半被杀掉然后重试会怎样？
- 两个用户同时提交相同请求会怎样？

每个发现追踪完整路径：入口 → 处理 → 存储 → 输出 → 副作用。

### Goal 模式 + 自动续命

每个委托任务都会创建一个 goal：一句目标，一段简短计划。goal 持久化到磁盘，能扛住两个通常会打断任务推进的情况：

**上下文压缩。** 当 OpenCode 压缩会话（长任务会自动触发），恢复上下文里只保留 subagent `task_id`。goal 本身通过 tool result 历史和 `get_goal` 工具恢复，让 goal 对模型的可见性和 todo 列表保持一致。

**进程重启。** goal 存在本地 JSON 文件里。杀进程、重启机器、明天再来——`opencode run --continue` 拿到同一个 session ID，goal 还在那里。

goal 自动续命直到显式关闭。agent 不会做完一步就停下来等你打"继续"。它持续推进：用内置 todo 工具更新 todo，把下一块工作委托给 sidekick，审查结果，只在工作验证完成或遇到明确 blocker 时才关闭 goal。

### 开放性任务的 reviewer 循环

有些任务没法预先规划完整步骤：性能优化、模糊根因排查、架构清理。这类任务用 reviewer 循环推进：

1. 做完一个 todo，带着证据找 reviewer
2. reviewer 判断下一步：`continue`（继续当前方向）、`pivot`（换方向）、`stop`（没有有意义的下一步了）、`blocked`（缺证据或前置条件）
3. 按 reviewer 的建议执行下一步，再回到 reviewer
4. 直到 reviewer 说 `stop` 且工作已验证，或 `blocked` 有具体阻塞原因

### 第一性原理

遇到 bug 修复、架构决策或方案选择时，agent 从基本事实和约束推导，而不是去训练数据里找最像的模式。

- 症状修复："抓取坏了，修一下 fetcher。"下周同样的 bug 又回来了。
- 根因修复："流量路由层有一个潜在的失败模式，fetcher 只是第一个受害者。修路由。"这类 bug 被彻底消除。

## 适合什么

- 长任务，需要跨越上下文压缩和进程重启而不丢失线索
- 复杂 debug，明显修复治标不治本
- 多阶段重构，关键决策不想交给便宜模型
- 高风险变更，交付前要独立审查
- 开放性工作，下一步做什么没法预先规划，需要 reviewer 循环帮忙收敛

如果只是随聊随停的轻量助手，这套可能太重了。

## 许可证

[MIT](LICENSE)
