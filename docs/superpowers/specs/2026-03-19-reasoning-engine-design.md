# 推理引擎设计

## 概述

为 ReMi 实现分身推理引擎。任何已认证用户向分身提问，分身通过 Batch Recall 召回相关锚点，生成"像本体会说的话"。推理流是 MVP 的第二条主线，与访谈流共享锚点库但运行逻辑完全不同：访谈流是知识采集，推理流是知识应用。

## 设计决策

| 决策     | 选择                               | 理由                                  |
| -------- | ---------------------------------- | ------------------------------------- |
| 架构     | 独立 `reasoning/` 模块             | 与 interview 平行，避免错误的早期抽象 |
| 会话模式 | 单会话持续型，per visitor per soul | 最简单，与访谈流对称                  |
| 访问控制 | 所有已认证用户                     | 通过公钥识别提问者身份                |
| 存储     | 新建 reasoning_messages 表         | 不污染访谈消息，职责清晰              |
| 人格策略 | 纯锚点召回                         | 不预设 Profile，从锚点中涌现          |
| 召回机制 | Batch Recall（多目标联合）         | 身份解析与问题回答联合推理            |
| 锚点缓存 | 复用 recalled_anchors 字段         | 已持久化的审计数据天然就是缓存        |
| 输出     | SSE 流式                           | 复用 thinking/token/done 事件格式     |

## MVP 范围

**包含：** 文字对话、Streaming 响应、多目标联合召回、锚点审计
**不包含：** 语音/图片输入、对话摘要、主动推送

## 核心流程

```
提问者发送消息
    │
    ▼
[Step 1] Batch Recall
    │  goals = [
    │    "我是谁，我的身份和表达风格",
    │    "对方是谁，我与对方的关系和沟通边界",
    │    "回答提问者的问题所需的认知"
    │  ]
    │  context = visitor 公钥 + 滑动窗口对话历史 + 缓存锚点
    │
    │  循环：
    │  ┌─→ LLM 综合所有 goals 联合判断充分性
    │  │   输出：哪些 goals 充分/不充分 + 下一个 query + 思考叙述
    │  │  不充分        充分
    │  └── 向量搜索 ──→ 输出最终锚点集合
    │
    ▼
[Step 2] 生成分身回复（chatStream）
    │  system prompt 注入召回的全部锚点
    │  综合对话历史 → 流式生成回复
    │
    ▼
保存对话记录（含 recalled_anchors 审计字段）
```

### 与访谈流的差异

- **无锚点提取**：提问者的消息不产出新锚点
- **无矛盾检测**：不涉及新锚点写入
- **Recall 机制不同**：访谈用单目标 Agentic Recall，推理用多目标 Batch Recall
- **生成角色不同**：访谈是"AI 主持人"，推理是"本体的分身"

## Batch Recall

### 与 Agentic Recall 的区别

|            | Agentic Recall (recall.ts) | Batch Recall                         |
| ---------- | -------------------------- | ------------------------------------ |
| 输入       | 单个 goal                  | 多个 goals                           |
| 充分性判断 | 针对单一目标               | 联合判断，goals 之间交叉影响         |
| Query 生成 | 围绕单一目标改写           | 跨 goal 生成（如从问题推断对方身份） |
| 用途       | 访谈流                     | 推理流                               |

### 联合推理的增量效果

多个 goals 在同一次 LLM 调用中联合判断，自然产生跨 goal 推理链路：

- "对方问投资建议" → 推断"对方可能是投资人" → 召回"我对投资人的态度"
- "我是技术背景" → 影响"用什么口吻回答" → 影响"哪些锚点与回答相关"

拆成独立的多次 Recall 会丢失这种增量效果。

### 函数签名草案

```typescript
interface BatchRecallOptions {
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient;
  searchAnchors: (embedding: number[]) => Promise<SoulAnchor[]>;
  goals: string[];
  context: string;
  cachedAnchors?: SoulAnchor[];
  maxRounds?: number; // 默认 5
  topK?: number; // 每轮 top-K，默认 10
  onNarrative?: (text: string) => void;
}

interface BatchRecallResult {
  anchors: SoulAnchor[]; // 最终召回的全部锚点（去重）
  narratives: string[]; // 思考叙述（按顺序）
  rounds: number; // 实际循环轮数
  sufficient: boolean; // 所有 goals 是否都达到充分
}

function batchRecall(options: BatchRecallOptions): Promise<BatchRecallResult>;
```

### 充分性判断 Prompt 策略

每轮循环中，LLM 接收：

- 所有 goals 列表
- 当前已召回的全部锚点
- 对话历史摘要
- visitor 公钥

输出 JSON：

```json
{
  "sufficient": false,
  "goalStatus": [
    { "goal": "我是谁...", "sufficient": true, "reason": "已召回身份和风格锚点" },
    {
      "goal": "对方是谁...",
      "sufficient": false,
      "reason": "对方未表明身份，需要查陌生人沟通方式"
    },
    { "goal": "回答问题...", "sufficient": false, "reason": "缺少关于投资观点的锚点" }
  ],
  "nextQuery": "我对陌生人的沟通方式和边界",
  "narrative": "让我想想你之前说过什么关于这个话题的...",
  "reason": "需要了解本体的沟通边界偏好"
}
```

`sufficient` 为 true 当且仅当所有 goals 都充分。`nextQuery` 由 LLM 自主决定，可以跨 goal。

## 数据模型

### 新增 reasoning_messages 表

| 列名             | 类型    | 约束             | 说明                                                                                                           |
| ---------------- | ------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| id               | INTEGER | PK AUTOINCREMENT | 消息 ID                                                                                                        |
| visitor_key      | TEXT    | NOT NULL         | 提问者公钥                                                                                                     |
| role             | TEXT    | NOT NULL         | `'user'` / `'assistant'`                                                                                       |
| content          | TEXT    | NOT NULL         | 消息内容                                                                                                       |
| recalled_anchors | TEXT    | NULL             | JSON string `string[]`（anchor ID 数组），仅 assistant 消息有值。DB 存序列化 JSON，API 返回解析后的 `string[]` |
| created_at       | INTEGER | NOT NULL         | Unix timestamp ms                                                                                              |

会话由 `visitor_key` 唯一确定（每个分身有独立 SQLite 数据库，不需要 soul 维度）。

查询时按 `visitor_key` 过滤 + `id` 排序 = 完整对话历史。

### 锚点缓存

不需要独立的缓存机制。`recalled_anchors` 审计字段天然就是缓存：

1. 收到新消息 → 从该 visitor 最近一条 assistant 消息的 `recalled_anchors` 中取出 anchor IDs
2. 用 IDs 从锚点库查出完整 `SoulAnchor[]` 作为 `cachedAnchors` 传入 Batch Recall
3. Batch Recall 在充分性判断时将 `cachedAnchors` 纳入已知锚点
4. 新召回的锚点去重合并后，存入本次 assistant 消息的 `recalled_anchors`

优势：

- 无需进程内 LRU Map，多实例部署无问题
- 自然持久化，进程重启不丢失上下文
- 数据来源单一（DB），不存在内存与 DB 不一致的风险
- 如果锚点已被删除（ID 查不到），自然淘汰过时缓存

### 滑动窗口

取最近 N 条对话消息作为上下文（默认 N=20），与访谈流一致。

## API 设计

所有端点在 `/api/:pubKey/reasoning/` 下，受 auth 中间件保护。

| 方法 | 路径                              | 说明                                |
| ---- | --------------------------------- | ----------------------------------- |
| POST | `/api/:pubKey/reasoning/message`  | 发送消息，触发推理流程，返回 SSE 流 |
| GET  | `/api/:pubKey/reasoning/messages` | 获取对话历史（游标分页）            |

访问控制：所有已认证用户（owner + visitor）均可访问。签名中的公钥作为 `visitor_key`。

不需要 `/start`（无 AI 先发言的冷启动）。不需要 `/status`（MVP 不需要推理统计）。

### POST /reasoning/message

请求体：`{ "content": string }`

返回 SSE 流，事件格式与访谈流一致：

```
event: thinking
data: {"narrative": "让我想想你之前说过什么..."}

event: token
data: {"content": "根据"}

event: done
data: {"messageId": 42, "recalledAnchors": ["id1", "id2"]}

event: error
data: {"code": "LLM_ERROR", "message": "..."}
```

`done` 事件额外包含 `recalledAnchors`（`string[]`，anchor ID 数组），方便前端展示和调试。与 DB 中 `recalled_anchors` 存储的内容一致（已解析）。

### GET /reasoning/messages

游标分页：`?limit=20&before=42`（before 是 message id）。

```json
{
  "data": {
    "items": [
      {
        "id": 42,
        "visitor_key": "...",
        "role": "assistant",
        "content": "...",
        "recalled_anchors": ["anchor-id-1", "anchor-id-2"],
        "created_at": 1710835200000
      }
    ],
    "hasMore": true
  }
}
```

## Prompt 策略

### 分身回复 System Prompt

```
你是 [本体] 的分身。基于本体的认知和价值观，像本体一样回答问题。

## 已知的本体认知（锚点）
- Q: [问题1] A: [答案1]
- Q: [问题2] A: [答案2]
...

## 规则
- 只基于已知锚点回答，不编造本体没有表达过的观点
- 如果锚点不足以回答，坦诚说明"我还没有足够了解本体在这方面的想法"
- 保持本体的表达风格（从锚点中推断）
- 宁可说"不知道"，也不编造
```

关键原则：**分身说出本体没说过的话，比说"我不确定"更有害。**

### Batch Recall 充分性判断 Prompt

输入：goals 列表 + 已召回锚点 + 对话历史 + visitor 公钥。
输出：JSON（goalStatus + nextQuery + narrative）。详见 Batch Recall 章节。

### Streaming 策略

Batch Recall 内部循环用 `chat()` 非流式调用。最终生成分身回复用 `chatStream()` 流式输出。与访谈流的 Step 1-3 非流式 / Step 4 流式策略一致。

## 模块划分

### 新增文件

```
packages/server/src/
├── reasoning/
│   ├── engine.ts          # 推理流编排（Batch Recall → 生成回复）
│   ├── batch-recall.ts    # Batch Recall 实现（多目标联合召回）
│   └── prompts.ts         # 分身回复 + Batch Recall 的 prompt 模板
├── routes/
│   └── reasoning.ts       # 推理 API 路由（2 端点）
└── db/
    ├── schema.ts          # 修改：新增 reasoning_messages 表
    └── migrate.ts         # 修改：新增建表语句
```

### 修改文件

- `app.ts`：挂载 reasoning 路由
- `types.ts`：新增 ReasoningMessage 类型（如需）

### 依赖关系

```
routes/reasoning.ts
  └── reasoning/engine.ts
        ├── reasoning/batch-recall.ts → llm/client.ts + embedding/
        └── reasoning/prompts.ts
```

`batch-recall.ts` 不依赖 reasoning 特有逻辑，将来可被其他流程复用。

## 测试策略

| 层级         | 测试文件                             | 方式                                     |
| ------------ | ------------------------------------ | ---------------------------------------- |
| Batch Recall | `reasoning/batch-recall.test.ts`     | Mock LLM + embedding，验证多目标循环终止 |
| 推理引擎     | `reasoning/engine.test.ts`           | Mock 子模块，验证编排逻辑                |
| API 路由     | `routes/reasoning.test.ts`           | Hono app + Mock 引擎，验证 SSE 流        |
| 端到端       | `test/reasoning-integration.test.ts` | 真实 DB + Mock LLM                       |

所有测试 mock LLM 调用，使用真实 SQLite。

## 错误处理

- **LLM 调用失败**：SSE `error` 事件，code = `LLM_ERROR`
- **Batch Recall 循环超限**（默认 max 5 轮）：强制终止，用当前结果继续生成
- **数据库错误**：返回 500
- **锚点库为空**：分身坦诚说明"还没有足够了解本体"

## 已知限制（MVP 接受）

- 无并发控制：同一 visitor 同时发多条消息可能竞态
- Prompt 模板硬编码
- 滑动窗口大小固定，不根据 token 数动态调整
