# 资源与资源组

以当前代码为准。本文说明玩家扫码使用的「资源」、把资源归类并决定收费的「资源组」，以及扫码后计费怎样开始。方案之间如何叠加和互斥见[计费状态编排](pricing-sessions.md)；金额怎么算见[当前计费如何运作](billing-flow.md)。

## 1. 资源

资源是玩家扫码的对象：机台、空调、门锁、麻将桌，或者只是贴在墙上的二维码（例如休息区入口）。资源仍存放在 `machines` 表，资源 ID、公开 ID、已打印的二维码和硬件能力都不变。

硬件能力（电源、空调、HINATA IO、门锁、麻将）是可选的。没有任何能力的资源同样可以扫码：页面只做计费确认，不显示硬件按钮。

资源只决定计费方案，不保存价格：

| 字段 | 含义 |
| --- | --- |
| `machines.resource_group_id` | 所属资源组；为空表示属于店铺的默认资源组 |
| `machines.pricing_config_override_id` | 资源专属方案；为空表示跟随资源组 |

## 命名

代码与界面统一称「资源」。服务端的资源定义在 `packages/server/src/resources/resource.ts`（`Resource`、`loadResource`），硬件能力目录与执行在 `resources/capabilities/`；路由为 `platform/resource-session.ts`（扫码页）、`resource-ticket.ts`（二维码票据）、`resource-actions.ts`（硬件操作）、`merchant-resources.ts`（管理）。网页为 `ResourcePage`、`ResourceControls`、`merchant/Resources`、`merchant/ResourceEditor`。

「设备」只用于真正的硬件：连接、电源、空调状态、设备令牌、硬件操作记录。为了不影响机器人、App Clip 和已打印的二维码，以下名称保持不变：数据表 `machines` 与相关列、HTTP 路径（`/api/v1/devices/session/*`、`/api/v1/merchant/machines`、`/t/:shop/:publicId`）、响应字段 `machine` / `machines`，以及错误码（`DEVICE_NOT_FOUND` 等）。

## 2. 资源组

| 资源组 | 存储 | 计费方案 |
| --- | --- | --- |
| 默认资源组 | 不单独存储，每店一个，ID 为 `default` | 店铺的默认计费方案，存于 `shop_billing_settings.entry_pricing_ids_json`，最多一个方案 |
| 其他资源组 | `resource_groups` 表（迁移 `0040_resource_groups.sql`） | `default_pricing_config_id` |

资源组只是逻辑分组，不是物理空间，也不是独立账单：结账仍是玩家级统一结算。

默认计费方案还用于没有扫码对象的入场：前台开单、收银台入场。机器人 `/login` 开始的是这个 Bot 资源的方案，Bot 在默认资源组时也就是默认计费方案。店铺没有设置默认方案时，若只有一个可开始的计时方案就用它，否则返回 `ENTRY_PRICING_REQUIRED`。从未建过资源组的店铺，计费行为与改造前完全一致。

资源组停用后，组内资源不能开始新的计费，已在进行的计费不受影响。组内还有资源时不能删除（`RESOURCE_GROUP_IN_USE`）。

## 3. 资源计费哪个方案

规则只有一条：资源专属方案优先，否则用资源组的方案。代码见 `packages/server/src/resources/billing.ts`。

- 专属方案**替换**资源组的方案，不会把两者叠加。需要叠加时，在计费页让专属方案 `requires` 另一个方案。
- 普通资源组没有设置方案、资源也没有专属方案时，返回 `RESOURCE_PRICING_NOT_CONFIGURED`，不会退回店铺默认方案。
- 资源所属的资源组已删除时返回 `RESOURCE_GROUP_NOT_FOUND`，停用时返回 `RESOURCE_GROUP_DISABLED`。
- 方案必须属于玩家当前计费版本里的计时方案，由编排器校验。

## 4. 扫码流程

在启用计费的店铺里，每个资源的方案都必须在玩家这里处于计费中，才能使用该资源，无论有没有硬件。

1. 玩家扫码，页面读取 `GET /api/v1/devices/session/bootstrap`。只读，不会开始任何计费。
2. 方案未在计费时，`state.gate` 为 `entry`，`state.billing.preview` 给出确认后会开始、结束和继续的方案，以及 `revision`。资源无法计费时，`state.billing.error` 给出原因，页面不提供确认。页面标题为「计费规则」，下面是一张卡片，内容见下文「扫码页的计费规则」。没有 `rules` 时（旧接口）按「新增方案」「结束方案」「保留方案」三行显示。无法计费时标题为「暂时无法使用」。确认按钮统一为「确认」。计费已开始后的操作页面不再显示计费规则。
3. 玩家确认，调用 `POST /api/v1/shops/:shopCode/player/session/start`，带上 `expectedRevision`。服务端重新计算；状态已变化时返回 `PRICING_STATE_REVISION_MISMATCH`，不按过期的预览执行。
4. 计费开始后，`gate` 变为 `ready`，页面显示该资源的硬件操作。方案已在计费时直接是 `ready`。

### 扫码页的计费规则

确认前要看的内容都在一张卡片里（`ui/ResourcePricing.tsx`），所有时间轴共用卡片底部的一条 0–24 点刻度：

- **方案**：该资源实际计费的每个方案一条（资源自己的方案在前，之后是它依赖的方案），颜色与账单时间轴相同（`ui/plan-colors.ts`）。
  - 标题行：方案名、确认后是「新增」还是「保留」，右侧是现在的价格。
  - 时间轴：每个时段一段，越贵颜色越深，空档为灰色；现在的位置是一个圆点，边框用这条时间轴的颜色。段内不写数字，具体价格点选该段查看。跨过 0 点的时段（如 22:00–10:00）是两段、颜色相同。
  - 下面一行说明现在所在的时段：名称、时间（跨 0 点的时段写作 22:00–10:00，`ui/period-rows.ts`）、时段封顶。当前时段写「已计 X / 封顶 Y」，封顶为 0 的时段不封顶，不写。
- **跨方案封顶**：在「跨方案封顶」小标题下，每个跨方案封顶（管所有按时计费方案）一条细时间轴。每个封顶窗口一段，当前窗口按「已计 / 封顶」的比例填色，填满即已封顶；标题行右侧是当前窗口的「已计 X / 封顶 Y」，下面一行是窗口名称和时间。全天的封顶也有分界点：06:00 重置的每日封顶是 0–6 与 6–24 两段，写作 06:00–06:00。
- **点选**：点时间轴上的任一段，这条时间轴的标题行和说明行改为显示该时段（价格、时间、封顶），该段加描边；再点一次或点现在所在的时段，回到现在。
- **底部**：有被结束的方案时一行「结束方案」；玩家有未结账金额时一行「已计」（各方案相加、扣除封顶之后）。

不显示各方案价格相加的合计单价：各方案的计费单位和开始时间都可能不同，相加没有意义。规则编辑页圆环下的时段列表同样把跨 0 点的时段合并为一行。

数据都在 `state.billing.rules`，取自玩家锁定的计费版本。封顶部分只在确认页（`gate` 为 `entry`）计算，放在 `rules.caps`：

- `unsettled`：玩家这次未结账的账单到现在的金额（各方案相加、扣除封顶之后）。
- `plans`：每个方案当前时段的封顶，不封顶的时段没有。
- `shared`：店里的跨方案封顶，另带它的规则配置 `config`，页面据此画出全天的窗口。

每项有 `priceCap`、`paidBefore`、`ruleId`、`ruleLabel`、`startsAt`、`endsAt`（当前窗口）。`paidBefore` = 这个窗口里已结账的金额（`pricing_history_entries` / `pricing_cap_history_entries`）+ 未结账 session 到现在已计入这个窗口的金额（取结账预览），与结账用同一套历史键。代码：`packages/application/src/cap-progress.ts`；窗口定位在 `@prism/core` 的 `priorityTimePricingWindowAt` / `timeCapPricingWindowAt`。日时间轴的每一段带 `windowStartedAt` / `windowEndedAt`，同一规则相邻的两段只在属于同一窗口时合并，所以 06:00 重置的封顶不会被并成一整段。

例如休息区：游戏区资源组的方案为「游玩差价」，休息区资源组的方案为「休息状态」，两者都依赖「普通游玩」，并且互斥。玩家扫音游机会开始普通游玩与游玩差价；之后扫休息区的空调，普通游玩继续计时，游玩差价结束，休息状态开始；再扫休息区入口，休息状态已在计费，直接进入页面。

各入口的检查方式一致，都用 `resourceBilling.activeSession`：

| 入口 | 行为 |
| --- | --- |
| 设备操作（开机、投币、空调等） | 资源的方案未在计费时返回 `403 CHECKIN_REQUIRED` |
| 刷卡登录 | 同上 |
| 门锁开门 | 方案未在计费时，带 `consent: true` 则开始该方案再开门，否则返回 `CHECKIN_CONSENT_REQUIRED` |
| 麻将入座 | 需要麻将桌这个资源的方案（等位方案）在计费中。店员或 Bot 代为入座时视为确认，直接开始该方案；但先检查座位，满桌不会开始计费。已开局的桌，占着座位就算在使用，见 [占用](occupancy.md#3-麻将等位) |
| 机器人设备操作 | 目标资源的方案都要在计费中，否则返回 `DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION` |
| 机器人入场 | 相当于扫码确认这个 Bot 资源：开始 Bot 的方案 |

麻将桌资源本身的方案（通常是普通游玩）在扫码时开始；麻将差价方案仍在满桌时开始，见[计费状态编排](pricing-sessions.md)第 5 节。

店铺启用计费但还没有任何计时方案时，沿用占位 Session：每次到店一条，不对应任何方案。

## 4.5 占用与查人

资源还有**容量**和**占用时长**：谁正在用它、能同时容纳几个人、多久没动静算离开。闲置自动关机、麻将等位和查人（Bot `list`、网页「在店」页）都建立在占用之上。见 [卡片、占用与查人](occupancy.md)。

## 5. 不再有「入场」身份

服务端不再根据 `label`、`metadata` 或方案列表判断一条 Session 是不是「入场」，`isEntry` 与 `startEntry` 已删除。默认方案的 Session 仍写入展示标签 `entry`，旧版机器人用它识别已入场；其他方案的 Session 标签为方案名称。标签只用于显示。

## 6. 管理接口与界面

商户接口挂在 `/api/v1/merchant`，权限与资源配置相同：

- `GET /resource-groups?shopId=`：默认资源组在第一位，带 `resourceCount`。
- `POST /resource-groups`：`{ shopId, name, defaultPricingConfigId?, enabled? }`。
- `PATCH /resource-groups/:id`：`{ shopId, name?, enabled?, defaultPricingConfigId? }`。`default` 只能修改方案，写入店铺默认计费方案。
- `DELETE /resource-groups/:id?shopId=`。
- 资源接口 `POST/PATCH /machines` 接受 `resourceGroupId`（`"default"` 或 `null` 表示默认资源组）与 `pricingConfigOverrideId`；列表返回这两个字段。

方案必须是本店未归档、能开始计费的方案（按时计费，或每次开始收一次的固定收费），否则返回 `RESOURCE_PRICING_INVALID`。默认资源组的方案就是店铺默认计费方案，它为没有其他方案的到店计时，所以只能是按时计费方案。扫码页的计费规则卡片里，固定收费方案没有时间轴，只写金额和「单次收取」。

商户工作台的「资源」页（`/merchant/:shop/resources`，旧地址 `/devices` 会跳转）按资源组分段列出资源，默认资源组在最前：

- 右上角「添加资源组」；每个资源组标题旁有「编辑」（名称、方案、启用、删除；默认资源组只能改方案，即店铺默认计费方案）和「添加资源」（新资源直接放进这个组）。
- 资源卡片显示占用人数和容量，以及正在占用的玩家；点玩家名打开他在「在店」页的详情和账单（`/merchant/:shop/live?player=`，玩家不在店时转到「玩家」页）。「操作记录」里先列占用记录，再列设备操作记录。
- 资源编辑页左侧分为「基本信息」（名称、别名、启用）、「计费与占用」（资源组、计费方案覆盖即专属方案、容量、占用时长；麻将桌这类按座位判断占用的资源，占用时长显示为不适用）、每个已启用的能力各一项，以及「添加能力」。Bot 能力一项里显示接入用的店铺编号和 API 地址。

「设置」里不再显示默认计费方案，也没有「Bot 与接入」分组；Bot 的接入和设置只在资源里。

## 6.5 Bot

机器人也是资源：带 `bot` 能力，不能扫码。它和其他资源一样有所属资源组和可选的专属方案，玩家通过它入场时开始的就是这个方案；没改过的 Bot 在默认资源组。能力配置里只存它的接入凭据 ID 和店家设置；店员、货币名称、麻将桌和门锁由平台推导后随 `GET integration/bot` 下发。详见 [Integration：Bot 是一种资源](integrations-and-machines.md#bot-是一种资源设置由服务端下发)。

## 7. 备份

店铺数据备份格式升级为 4：新增 `resource_groups` 表，`machines` 行新增 `resource_group_id` 与 `pricing_config_override_id`。资源引用了备份中不存在的资源组时，导入检查会拒绝。仍可导入版本 1–3 的文件，其中的资源都属于默认资源组。

## 8. 验证

```bash
bun test packages/server/test/resource-billing.test.ts
bun test packages/server/test/resource-scan.test.ts
bun test packages/server/test/roster.test.ts packages/server/test/occupancy.test.ts
bun test packages/server/test/mahjong-pricing-sessions.test.ts
bun test packages/server/test/shop-data-transfer.test.ts
```
