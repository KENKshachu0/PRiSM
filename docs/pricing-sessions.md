# 计费状态编排（Session Lifecycle）

以当前代码为准。本文说明 Session 如何开始和结束、计费方案之间的 `requires` / `conflicts` 关系，以及各入口如何共用同一个编排器。费用怎么算不在本文范围：金额仍由 `packages/core/src/pricing-time.ts` 与 `settlement.ts` 计算，见[当前计费如何运作](billing-flow.md)。

## 1. 一条 Session 只计一个方案

- 新 Session 的 `pricing_config_ids_json` 必须恰好包含一个方案，否则返回 `PRICING_CONFIG_SINGLE_PLAN_REQUIRED`。这个方案就是 Session 的 `pricingConfigId`，用于开始、结束和去重；它只从这一列读出，从不根据 `label` 或 `metadata` 推断。
- Session 能计的方案有两种：按时计费（`time.priority`），以及固定收费（`charge.fixed`，这个 Session 结账时收一次固定金额，例如一张麻将桌每局一笔）。消费封顶（`time.cap`）只在结算时调整，不能开始。
- 未配置任何计时方案的店铺仍使用占位 Session（`["default"]`），它没有 `pricingConfigId`，不参与方案关系。
- 已结账的历史多方案 Session（线上只有导入遗留与短暂误配，共二十余条）保持原样，没有 `pricingConfigId`。
- 迁移 `0039_session_single_plan.sql` 建立部分唯一索引 `idx_sessions_active_plan`：同一店铺、同一玩家、同一方案最多一条 active Session。迁移带守卫：只要还有 active 或未付款的多方案 Session，迁移就中止，不会悄悄把它归到其中一个方案。

## 2. 方案关系

关系只能声明在 `time.priority` 方案上，也只能指向按时计费方案；固定收费方案可以单独开始，但不参与依赖与冲突（`PRICING_RELATION_UNSUPPORTED_TARGET`）。关系存放在方案 `provider_json` 的 `relations` 字段里，因此由现有版本触发器一起进入不可变版本，未结账的玩家始终按锁定版本里的关系编排。没有关系的方案不写这个字段，保存时存储字节不变，不会凭空产生新版本。

| 关系 | 含义 | 行为 |
| --- | --- | --- |
| `A requires B` | `A` 活跃时 `B` 必须活跃 | 开始 A 时自动开始 B；B 已在计费则复用，不重置 `startedAt`；结束 A 不结束 B；结束 B 时一并结束 A |
| `A conflicts B` | 两者不能同时活跃 | 开始一方时自动结束另一方及依赖它的方案；只在一侧声明也双向生效 |

保存方案时会用整店方案重建关系图，以下情况直接拒绝保存：引用自身、重复引用、引用不存在的方案、引用非计时方案、在非计时方案上声明关系（`PRICING_RELATION_UNSUPPORTED_KIND`）、依赖循环（`PRICING_RELATION_CYCLE`）、依赖闭包内互斥（`PRICING_RELATION_CONTRADICTION`）。仍在被使用的方案不能归档（`PRICING_CONFIG_IN_USE`，409），错误信息列出使用者：未归档规则的「依赖」、资源组的方案、资源的专属方案、店铺默认方案和麻将桌方案。停用方案仍然允许；之后开始依赖它的方案会返回 `PRICING_REQUIREMENT_UNAVAILABLE`。

商家在「计费」页编辑计时规则时，在底部「规则关系」里点选「依赖」与「冲突」的规则，下方一行说明两者的效果：开始本规则时，依赖的规则同时开始，冲突的规则结束。界面不用「需要同时计费」这样的说法，因为它读起来像双向关系，而依赖是单向的。其他规则声明的冲突在本规则里显示为已选、不可修改；同一个规则不能既是依赖又是冲突。「计费」页的「规则关系」图把未归档的计时规则按依赖分层画出：被依赖的规则在上，实线箭头指向依赖的规则，红色虚线连接冲突的规则，方框下方是使用该规则的资源组，停用的规则为虚线框；点击方框打开该规则的编辑。

## 3. 编排器

`packages/application/src/pricing-session-orchestrator.ts`，在店铺依赖里是 `pricingSessions`：

```ts
getActive(playerId)
previewActivate({ playerId, pricingConfigId })
activate({ playerId, pricingConfigId, expectedRevision?, label?, metadata?, sessionId?, at? })
previewDeactivate({ playerId, pricingConfigId })
deactivate({ playerId, pricingConfigId, expectedRevision?, at? })
```

- 方案集合取自玩家适用的计费版本：有未结账 Session 时为其锁定版本，否则为当前版本；已停用和已归档的方案也在内，以便关系目标总能解析。不在其中的方案返回 `PRICING_PLAN_NOT_FOUND`。
- 规划是纯函数（`packages/core/src/session-transition.ts`、`pricing-relations.ts`）。写入前先检查结束后的活跃集合满足关系，不满足就不写。
- 一次转换的全部变化使用同一时间点：被结束的 `endedAt = T`，新开始的 `startedAt = T`，被保留的方案不受影响。结束只改 `status` 与 `endedAt`，`paymentStatus` 保持 `unpaid`。
- 重复开始已在计费的方案返回原 Session，`changed: false`，不写数据库。
- `preview*` 不写任何数据。`expectedRevision` 是活跃集合的指纹，与提交时不一致返回 `409 PRICING_STATE_REVISION_MISMATCH`。
- 目标已在计费、但活跃集合违反关系（例如计费途中新增了互斥）时，普通重复开始返回 `PRICING_STATE_INCONSISTENT`；带着预览的 `expectedRevision` 确认才会执行修复。
- 计划外的时段（方案规则此刻不计费）返回 `PLAYER_SESSION_OUTSIDE_BILLABLE_TIME`。

写入通过 `SessionRepository.applyTransition` 在一个批次里完成：关闭语句只作用于仍 active 的 Session，新 Session 由唯一索引兜底，批次中任一语句失败则整体回滚。没有单独的切换记录表：一次切换里被结束和被开始的 Session 使用完全相同的时间点，这本身就是切换的记录。重复开始同一方案被索引拒绝时返回 `PRICING_PLAN_ALREADY_ACTIVE`（409）。

## 4. 并发

开始、结束、结账、钱包、兑换与商品购买共用同一把玩家租约 `PLAYER_BILLING_LOCK_SCOPE`（存储值仍为 `player.assets`，部署期间持有的租约保持兼容），开始不会与结账交错。租约在同一调用链内可重入：已持有租约的路由（收银台入场、麻将入座）再调用加锁的服务不会自锁。可重入由 `#lease-context` 子路径导入提供，Worker 与 Bun 使用 `AsyncLocalStorage`，浏览器构建（只用于报价）使用空实现。

## 5. 各入口

开始计费只有一个入口：`resourceBilling.activate`（`packages/server/src/resources/activation.ts`）。目标有两种写法：一个资源（开始它的方案）或一个方案；没有默认计费方案，两者都不写返回 `PRICING_TARGET_REQUIRED`。它在玩家计费锁内解析目标并调用编排器，处理没有计时方案时的占位 Session，并返回 `created`：目标方案这次是否新开始。`resourceBilling.preview` 用同样的目标给出预览。扫码确认、门锁开门、店员开单、收银台、机器人入场都调用它，响应里的 `billing` 统一为 `{changed, created, started, stopped, kept}`（方案名）。麻将入座需要为整桌共享同一时间点，直接调用编排器。

| 入口 | 行为 |
| --- | --- |
| 玩家扫码确认、门锁开门 | 开始扫码资源的方案（资源专属方案，否则资源组的方案），见 [资源与资源组](resources.md) |
| 店员开单 | 开始店员指定的方案，不指定返回 `PRICING_TARGET_REQUIRED`。店员开单先调用 `session/preview` 显示会新增、结束、保留的方案，确认时带 `expectedRevision` |
| 收银台入场 | 前台是资源：开始「前台资源」的方案（专属方案，否则所属资源组的方案），见 [前台收银](cashier.md) |
| Integration / Bot 入场 | Bot 是资源：开始这个 Bot 的方案（专属方案，否则所属资源组的方案）；已在计费则复用原 Session（`created: false`）。请求里的方案、`label`、`entry` 都被忽略 |
| 停止单条 Session（店员、玩家、Integration） | 有 `pricingConfigId` 的按方案 `deactivate`，依赖它的方案同时结束；没有的（占位、历史）按原方式只关闭这一条 |
| 麻将入座 | 要求麻将桌这个资源的方案（等位方案）在计费中（店员或 Bot 代为入座时直接开始）。座位跟着它当前所在的 session：等位时是等位方案的，开局后是麻将方案的；麻将方案与等位方案互斥时，开局会结束等位方案而座位保留。满桌（或桌上已有人在计费）时，为每位等待中的玩家 `activate(麻将方案)`，同一时间点；先逐一预览，任何一位无法计费则都不开始，并撤销本次入座 |
| 麻将下桌 | 只结束座位当前所在的 session：已开局时 `deactivate(麻将方案)`；等位中时结束为这张桌开始的等位方案（没有其他方案依赖它时）。随之开始的基础方案继续计费，再删除座位；响应带 `billing.remaining`。见 [卡片、占用与查人](occupancy.md#3-麻将等位) |
| 其他原因结束麻将计费（互斥切换、停止所依赖的方案） | 编排器写入后通过 `afterClose` 释放这些 Session 对应的麻将座位 |
| 结账 | 不变：关闭全部 active Session 并统一结算 |

麻将桌只能选择一个计费方案（商家接口最多一个）。要叠加在普通游玩上，就让麻将方案 `requires` 普通游玩。

不再有「入场」身份：代码不根据 `label`、`metadata` 或方案列表判断 Session 是否入场，`isEntry` 与 `startEntry` 已删除。使用资源只看该资源的方案是否在计费。Session 以方案名称为展示标签，不再写 `entry`；标签只用于显示。

## 6. 验证

```bash
bun test packages/core/test/pricing-relations.test.ts packages/core/test/session-transition.test.ts
bun test packages/application/test/pricing-session-orchestrator.test.ts packages/application/test/pricing-session-billing-regression.test.ts
bun test packages/adapter-sqlite/test/session-single-plan.test.ts
bun test packages/server/test/mahjong-pricing-sessions.test.ts
```

`pricing-session-billing-regression.test.ts` 复现设计提案的例子：普通游玩 13 元/h 从 00:00 开始，01:10 开八口机 +2 元/h，02:00 结账，普通游玩始终是同一条 Session，总价 26 + 2 = 28 元；切到四口机 −2 元/h 后为 39 元。
