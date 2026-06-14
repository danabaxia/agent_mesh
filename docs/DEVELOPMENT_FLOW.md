# Development Flow — agents_mesh

> **Status:** codex-converged R1→R4 APPROVED（评审日志见 [DEVELOPMENT_FLOW.review.md](DEVELOPMENT_FLOW.review.md)）。
>
> 这个项目的 agent 开发流程与经验心得。
>
> **这是一份处方（prescriptive），不是实录（descriptive）。** 对 session transcript 的审计显示：实践中
> MVP→重型流的交接常常是隐式的、codex-spec-review 从未真正当过"回滚闸"、brainstorm 被多次重启成并行设计周期。
> 本文把这些隐含的、本应如此的规则**显式化**，用来纠正现状 —— 所以它和历史 transcript 会有出入，那是有意为之。

真相源：git 历史 + `docs/superpowers/{specs,plans}/` 的 artifact 留痕。每一步都落成可审查的文件。

本仓库有两条并行的流程线：

1. **主干（决定*正确性*）**：brainstorming → MVP → codex-spec-review → writing-plans → TDD → review。
2. **可视化层（决定*对齐*）**：whitebox/PRD → MVP 浏览器原型 → walkthrough。让人能看见、能在每一步纠偏。

---

## 一、规范流程（canonical sequence）

**核心更正：MVP 不是绕过重型流的并行快道，而是 brainstorming 的一个内部阶段。** 它是顺序的，不是分支。
这样安排的唯一目的：**用最少的代码消除 agent 与 user 之间的认知偏差**，避免"凭空想象设计 → 大改 → 再大改"的反复 token 浪费。

> **技能机制的硬约束（必读）**：本流程是人类层面的*意图*，但落到已安装的 superpowers 技能上有两条不可违反的机制，§二给出二者的衔接：
> - `superpowers:brainstorming` 有 **HARD-GATE**：在向用户*呈现一份设计 checkpoint* 之前不许进入实现。
> - `mvp-loop` 在其循环期间**压制 brainstorming**（这是它的设计，需显式具名 opt-in 才生效），收敛后**再交回 brainstorming 定稿**（mvp-loop §5 自带 handoff）。
>
> **拒绝清单是全局否决项**（§三）：命中即**同时**否决"MVP 捷径"和"跳过 brainstorm 旁路"，无一例外。

```
P0  架构对齐        draw_and_plan whitebox + co-evolving PRD（→ PROJECT.md）
        │
P1  brainstorming   探索意图 / 需求 / 设计
        │           └─ 内含 MVP 阶段（见 §二）：有了想法之后，搭最简可跑 demo，
        │              和用户多轮交互收敛 —— 这一步仍属于 brainstorm，不是它的替代
        ▼
P2  ★ 设计批准闸：MVP demo(Mode A) 或 设计 checkpoint(Mode B) 被用户批准
        │           未批准 → 留在 P1 继续 MVP/设计 迭代，不放行
        ▼
P3  codex-spec-review   独立第二模型评审，收敛到 APPROVED（见 §四 4.1）
        │           └─ supervisor 回滚闸（§四 4.2 任一触发）→ 回 P1
        ▼
P4  writing-plans       拆 Task 1..N，每 Task 带 RED/GREEN
        ▼
P5  subagent / executing-plans   逐 Task TDD 实现
        ▼
P6  code-review / verify / walkthrough   评审 + 核对意图（评审意见回流成 (review) commit）
        ▼
P7  finishing-a-development-branch   merge / PR

旁路（skip-brainstorm）：产物是「代码变更」而非「设计文档」的任务
        —— bug 修复 / 安全补丁 / 基础设施 init（CLAUDE.md、配置）——
        直接进 fix → code-review，不走 P1–P3。判据见 §三。
```

对应真实产物：

| 阶段 | 驱动技能 | 产物 | 过闸条件 |
|------|----------|------|----------|
| P0 | `draw_and_plan`(+`from-brainstorm`/`check-feedback`) | whitebox + PRD（→ `PROJECT.md`） | 架构在白板上对齐 |
| P1 | `superpowers:brainstorming`(+ MVP 阶段，§二) | `*-design.md` + MVP demo + ≤80 行 MVP doc | P2 设计批准闸：Mode A `MVP_APPROVED:true` 或 Mode B `DESIGN_APPROVED:true` |
| P3 | `codex-spec-review` | `*.review.md`，spec 标 `converged R0→Rn APPROVED` | Codex 与 Claude 双方收敛，无致命问题 |
| P4 | `writing-plans`(+`designing-evals`) | `*-plan.md` | Self-Review 段过、无 placeholder |
| P5 | `subagent-driven-development`/`executing-plans` | `feat/fix` commits（TDD） | 全套测试绿 + 逐增量审批闸（计划内 `STOP`，§六.3，≠ P2） |
| P6 | `requesting-code-review`/`code-review`/`security-review`/`verify`/`walkthrough` | `(review)` commits、`WALKTHROUGH.html` | 实现 vs 意图无偏差 |
| P7 | `finishing-a-development-branch` | merge / PR | 用户选定集成方式 |

---

## 二、MVP 阶段（P1 内部）

**MVP 是 brainstorm 的一部分，目的是"用能跑的代码替代猜测"，把设计空间砍小。**

### 技能编排（解决 brainstorming 硬门 vs mvp-loop 压制的冲突）
按以下**确定顺序**走，三个技能各自的机制就不打架：

1. **brainstorming（前段）** —— 探索意图/需求，产出一份**临时设计 checkpoint**（满足 HARD-GATE 的"先呈现设计再实现"）。此 checkpoint 是临时的，会被 MVP 反馈推翻或确认。
2. **显式 `/mvp-loop`（具名 opt-in）** —— 这一步**合法地压制 brainstorming**（正是 mvp-loop 的设计）。**每轮 ≤150 行**（per-round 上限，mvp-loop 自带），搭最简可跑 demo 给用户看。先过 §三的拒绝清单（§3.0 eligibility）才允许进入。
3. **mvp-loop 收敛 → 交回 brainstorming（mvp-loop §5 handoff）** —— 带着 MVP doc 路径 + `start_sha..converged_sha`，回到 brainstorming **把临时 checkpoint 定稿成正式 `*-design.md`**。
4. → **过 P2 闸**（MVP doc 满足 `MVP_APPROVED:true`，见下）→ 才进 P3 codex-spec-review。

> 一句话：**brainstorm 出临时设计 → /mvp-loop（压制 brainstorm、跑 demo、收敛）→ 交回 brainstorm 定稿 → codex 评审。** MVP "属于 brainstorm" 指的是这条闭环，不是在 brainstorming 技能内部偷偷写代码。

### 前端 / 后端：都要有最简 demo，但分开讨论
- **前端 demo**：UI / 网页 / 交互的最简形态（`mvp.html`、`frontend-design`）。明确"哪些 UI 是 MVP、哪些留后续"。
- **后端 demo**：API / 数据流 / 核心逻辑的最简形态。哪怕只是 1–2 段架构 + 一个能跑的桩。明确"哪些接口是 MVP、哪些留后续"。
- **前后端分开讨论**：两者各自和用户过一遍，不要混成一团。若高度耦合（如仪表盘 = 浏览器 UI + SSE 后端），**显式说明耦合是否可接受**，而不是默默打包。

### P2 设计批准闸（两种满足方式 —— 可机器判定）
P2 的本质是"**用户批准了将进入 P3 评审的设计**"。它有**两条满足路径**，覆盖"做了 MVP"和"被禁止做 MVP（命中拒绝清单/重型路径）"两种情况 —— 任一满足即过闸：

**Mode A（走了 MVP 的路径）** —— MVP doc（`docs/superpowers/mvp/YYYY-MM-DD-<slug>-mvp.md`）**必须**含以下字段，缺一不放行：

| 字段 | 含义 |
|------|------|
| `demo_ref` | 复现命令或 URL（如 `node ./bin/agent-mesh.js dashboard … --no-open` + 路径） |
| `user_approval_quote` | 用户**逐字**的批准原话（不是 agent 转述） |
| `open_feedback_count` | 未解决反馈条数 —— **必须为 0** 才放行 |
| `frontend_scope` / `backend_scope` | 前/后端各自"哪些是 MVP、哪些留后续"，耦合点已说明 |
| `MVP_APPROVED` | 布尔，仅当上述全满足时置 `true` |

**Mode B（未做 MVP 的重型/风险路径）** —— 命中拒绝清单、或 MVP 中途退出的工作，**不产出 demo**，改由用户直接批准 brainstorming 的**设计 checkpoint**。在 `*-design.md` 头部记：`user_approval_quote`（逐字）+ `DESIGN_APPROVED:true`。无 demo 字段。

判据明确化（两 Mode 通用）：用户回复**仅当**匹配 mvp-loop §3.1 的收敛模式（如 `looks good` / `ship it` / `approved`，无否定词）才算批准；含变更请求的"具体反馈"**不是批准**，回到迭代/继续设计。

> **审计教训**：实践中这道交接常是隐式的 —— 主 session 里你自己问过 *"the purpose of MVP is use minimal token to try the plan and see if user likes it before massive coding. can you check if this is what you did?"* 那句话就是认知偏差的现场证据。把交接做成上面这张**带 `MVP_APPROVED` 的检查表**，正是为了消除它。

---

## 三、分流与旁路判据

### 拒绝清单（全局否决，优先于下面所有分流）
命中任一项 → **既不能用 MVP 捷径、也不能跳过 brainstorm**，必须走完整 P1–P3：
- auth / 权限 / 加密 / session · schema 迁移 · 不可逆删除 · 受保护配置写入（含 `.claude/`、registry/agent.json 等 PROJECT.md Boundary 5）· 跨切面不变量 · 外部副作用 · 新增 API / 新数据契约

> 这条**压倒**下面的"跳过 brainstorm 旁路"：哪怕看起来像"一个补丁"，只要碰到上面任一项（典型如**安全补丁改了鉴权、settings 改了受保护配置**），就**不准跳**。

### 何时走完整 P1–P3（brainstorm-first）
默认。涉及设计决策、要产出设计文档的工作都走主干。

### 何时跳过 brainstorm（旁路 —— 客观判据，全部满足才算）
不是"没有设计文档"这种循环判据。必须**同时满足**：
- 改动局部（单点/单文件级），且
- 有一个**已知缺陷或失败测试**在驱动（bug 修复、回归），或纯机械变更（rename、依赖升级、init 脚手架），且
- **不引入**：新 API / schema / 安全不变量 / auth / 受保护配置 / 外部副作用 / 跨切面行为（= 不命中上面的拒绝清单）。

满足 → 直接 fix → code-review。否则走主干。
> 审计证据：项目 init(48defbc6) 这类纯脚手架确实跳过了 brainstorm —— 合理。但"安全审计"若产出设计变更，则**不**属于可跳过项。

### 何时该退出 MVP（§3.1 每轮再判，强制）
MVP 阶段每一轮都把当轮反馈重套**拒绝清单**；命中 → 立刻退出 MVP。对"投资规模"也设界，防止 MVP 变成偷偷做大设计 —— 注意**两类阈值不同**：
- **每轮（per-round）≤150 行** —— mvp-loop 自带的单轮提交上限，不是退出条件。
- **累计（cumulative）退出条件**：累计 >~400 行 **或** 反馈 >5 轮 **或** 冒出新设计问题 → **退出 MVP，回到 P1 brainstorm 定稿**，再依次过 **P2（Mode B）→ P3**。
- **不允许跳过 P2 或 P3。** 退出 MVP 不等于"直接进 writing-plans"：任何规模的设计仍必须经 P3 codex 评审。若 MVP 前已投入 >300 行 spec/plan，说明重型设计早已启动 —— 那就以该 spec 进 **P3 评审**（不是跳过 P3 直接 P4）。

> **When in doubt, refuse the MVP shortcut.** 一次错误的 MVP 跑在安全敏感改动上，代价远高于一次多余的重型设计跑在其实很简单的东西上。

---

## 四、P3 评审：codex-spec-review（打磨）+ 监督回滚闸（独立决策）

把两件事**分开**，因为它们由不同主体执行 —— 这是对"codex-spec-review 本身就是个收敛循环、并没有回滚语义"这一事实的尊重：

**4.1 codex-spec-review 本体（不变）** —— Codex 当独立第二模型，逐轮 `CHANGES_REQUESTED`→修→再审，收敛到 `APPROVED`，5 轮封顶。它的终态只有 `APPROVED` / `CHANGES_REQUESTED`，**没有"回滚"这个动作**。持续分歧或到轮数上限 → 按技能规定**升级给用户裁决**。

**4.2 监督回滚闸（Claude/人在 P3 之上的独立判定）** —— 读 codex 的 findings 后，由 supervisor 决定是否回 P1，触发条件**具体且可判**（满足任一）：
- 出现一个 **BLOCKER，且它推翻了 MVP 已被用户验证的核心假设**（不是实现细节，而是"这个方向本身错了"）；或
- **同一个 BLOCKER 跨 ≥2 轮未能解决**，或技能已把"持续分歧"升级给用户，且用户选择重做。

判定后的**终态显式二选一**：`APPROVED → P4` ｜ `ROLLBACK_TO_BRAINSTORMING → P1`（带上 codex 的 BLOCKER 原文作为回炉理由）。其余情况一律原地修（留在 4.1 循环）。

> 没有 4.2，评审就退化成"只会让设计更精致、不会喊停"的橡皮图章；但 4.2 是 supervisor 的职责，不是硬塞给 codex-spec-review 技能 —— 后者只管收敛。

---

## 五、可视化 / HTML 设计层（与主干并行）

仓库本身从一个 draw_and_plan whitebox 孵化（`8a9b3e3 chore: seed agents_mesh from validated draw_and_plan whitebox`）。视觉层在三处锚定：

1. **设计前（P0）** —— `draw_and_plan` whitebox + co-evolving PRD（`PROJECT.md` 由此长出）。`from-brainstorm` 桥接、`check-feedback` 排空 viewer 评论回流 PRD。
2. **MVP 中（P1）** —— `mvp.html` 浏览器原型 + `frontend-design`，形状在浏览器里被看见、被砍。
3. **实现后（P6）** —— `walkthrough`（`WALKTHROUGH.html`）把实现 vs 意图逐条对照；`project-map` 架构思维导图；`verify`/`run` 真跑截图（`dash-initial.png`）。

**一句话**：主干保证*正确*（可单测、可对抗评审），视觉层保证*对齐*（人能看见、能纠偏）。

---

## 六、贯穿全程的工程纪律

1. **文档是真相源**：`PROJECT.md` 是 PRD + 威胁模型；改不变量必须**先改 PROJECT.md**。CLAUDE.md 的 "Invariants" 是安全属性而非风格。
2. **纯核 / 脏壳分离**：可单测证明的安全逻辑（path-guard、context、change-detect）是纯函数；只有 `claude`/`git` spawn 碰外部世界。
3. **增量审批闸（P5 内，区别于 P2）**：实现计划里硬编码 `STOP — MVP approval gate`，未批不进下一 Increment。这是 writing-plans 的**逐增量**门，和 P2 的**设计批准闸**是两个不同的闸。
4. **测试零依赖、默认 hermetic**：`node --test` + stub 掉 `claude`；真 `claude` e2e 用 `AGENT_MESH_E2E=1` opt-in。
5. **commit 语义化前缀**：`docs(spec)`/`docs(plan)`/`feat`/`fix`/`refactor`/`test`，scope 标子系统，评审回流 commit 标题点名 review。

---

## 七、让它"成架构"的三条不变规则

1. **每阶段必产可审查 artifact** —— 没有口头交接。spec / review log / plan / commit / walkthrough 全部落文件，回放即审计。
2. **每转换必有机器可判的闸** —— P2 设计批准（`MVP_APPROVED:true`／`DESIGN_APPROVED:true`）、`converged APPROVED`、测试绿、拒绝清单。不是"感觉差不多了"。
3. **两条回边不可省** —— ① P3→P1 致命问题回滚；② P6→P5 评审意见回流（`(review I-1/I-2)` 这类 commit 就是这条边）。流程是带回路的，不是直线。

**总纲一句话：** 白板对齐 → brainstorm（内含 MVP，前后端分开、用户批准）→ codex 评审（打磨+回滚闸）→ 拆 Task → TDD → 评审回流 → 核对意图 → 收尾。主干保正确、视觉层保对齐、每道闸机器可判、关键回边不可省。

---

## 八、编排范式（workflow 审计 / codex 收敛）

> **非规范条款 · 收敛后追加。** §一~§七 是经 codex R1→R4 评审的流程规范；本节是把"工具层"从画图/原型/walkthrough（§五）扩展到**审计与收敛**的可复用手法，附本文自身的实操 case，供以后照做。

主干用 skill 串流程；当需要**核对"实践 vs 自述"**或**让流程文档本身经得起第二模型推敲**时，用下面两种编排：

### 8.1 多子 agent workflow 审计
对"我是不是真按某方法在做"这类问题 —— 历史散落在大量 session transcript 里，单上下文装不下：

1. **抽取轻量视图**：把 transcript（本仓库 11 个、47MB）用 `jq` 压成"`[USER]` 消息 + `[SKILL]` 调用"的时间线（→148K），避免子 agent 读原始 jsonl 爆上下文。
2. **fan-out 廉价模型**：`Workflow` 里每个 transcript 派一个 **haiku** agent（带 schema 强约束输出），逐条核对假设 H1..Hn，给 supported/partial/contradicted/not_observed + 证据。
3. **barrier 综合**：所有 finding 收齐后，一个 haiku agent 汇成报告（判定表 + 偏差 + 修正建议）。
4. **诚实标注盲区**：抽取只保留 USER+SKILL，prose 级动作（搭 demo、前后端讨论）看不见 → 凡判 not_observed 的，先归因到抽取盲区，不当作"真没发生"。

> **成本心法**：读 transcript 这类"量大、判断浅"的活，用 haiku；不要用主模型逐个啃。

### 8.2 用 codex-spec-review 收敛流程文档
codex-spec-review 不止评审 design spec —— **流程/规范文档本身**同样可收敛。本文即一例：写初稿 → `codex exec -s read-only` 评审 → 逐条 fix/rebut → 再审，**R1→R4 收敛（findings 6→4→1→0）**，日志见 [DEVELOPMENT_FLOW.review.md](DEVELOPMENT_FLOW.review.md)。

> **两个踩过的坑**：① workflow 脚本里 `await parallel(...)` 的括号绑定错误会让整跑 0 agent —— 用 `scriptPath` 改一行重跑即可。② codex xhigh reasoning 会去爬遍 sibling spec 而不出 verdict —— prompt 里硬加"只读 ≤2 个文件、立刻给结论"就收住了。

**本 case 的产物链**：condensed timelines（`/tmp`）→ 审计报告 → 流程修正 → codex 收敛 → `DEVELOPMENT_FLOW.md` + `.review.md` → commit `5ce03cc`。
