# 远端点播实时活动（Remote Live Activity）

## 目标

玩家在 iOS 上已经能看到店铺计费的实时活动（灵动岛 / 锁屏）。这些活动原本是**纯本地**的：由 App 自己 `Activity.request` 创建，只有 App 回到前台轮询时才会更新或结束。

本功能让**任意渠道**发起的入场或结账都能更新那台手机：

- 玩家自己在 App / App Clip 扫码入场；
- 管理员在后台为某个玩家「入场计费」或「结账」；
- 店铺 Bot / 集成接口按 平台身份或卡号发起入场或结账。

关键要求是 **App 不需要在运行**。玩家挂起甚至强杀 App 之后，管理员的一次后台结账仍然要让灵动岛在几秒内变成「本次计费已结束」。

## 为什么用 ActivityKit 直推，而不是静默推送

苹果提供 ActivityKit 的远端更新通道：创建活动时用 `pushType: .token` 拿到一个 **per-activity 推送令牌**，服务端持该令牌直接向 APNs 发送 `apns-push-type: liveactivity` 的 update / end 事件，系统会直接刷新灵动岛。

另一种做法是发静默推送（`content-available`）把 App 唤醒，再由 App 本地更新活动。**这个方案在本场景不可行**：静默推送不会启动被用户强杀的 App，而「App 不在前台」正是本功能要解决的核心场景。因此采用直推。

## 架构

```
[App / App Clip 前台登录]
   Activity.request(pushType: .token)
     → activity.pushTokenUpdates → POST .../player/live-activity/register
     → live_activity_tokens (shop_id, user_id, activity_id, token, bundle_id, session_id)
                                                        ↑ 查令牌
[任意渠道：玩家 / 管理员 / 收银台 / Bot]
   POST /api/v1/shops/{shopCode}/.../session/start | checkout/confirm | sessions/:id/stop
     → packages/server 店铺路由 → application 核心 → sessions.save
     → 响应 2xx → response.clone().json() → 解析 playerId → 反查 user_id
     → executionCtx.waitUntil(refreshActivityBill(...)) → LiveBilling Alarm → pusher.send(...)
                                                        ↓
   APNs (apns-topic = <bundleId>.push-type.liveactivity)
                                                        ↓
                                        灵动岛 / 锁屏实时更新
```

### 通知钩子的位置

`packages/server/src/routes/shops/index.ts` 的租户中间件统一处理玩家、管理员、收银台与 Bot 的成功写操作。通知规划和派发全部进入 `waitUntil`；解析、数据库或 APNs 故障不会把已经成功的结账改成失败响应。失败请求、幂等重放、活动令牌接口与只读预览不触发业务通知。

普通结账、改价结账、充值结账、收银台结账及批量结账均标记为结束事件；批量响应递归提取会话 ID，逐玩家通知。玩家停止子会话同样触发摘要同步；调度器按真实付款状态决定保留“待结账”还是结束活动。资产调整、兑换、商品订单变更从返回的资产流水、兑换记录和订单解析玩家；共享资产、优惠和计价定义变更通知当前已注册活动的玩家。设备和麻将操作沿用各自的摘要同步入口。

APNs 令牌和通知属于服务端传输层，`application` / `core` 不依赖 APNs。`live-activity/register` 与 `live-activity/unregister` 仍由服务端直接处理。

### 玩家身份如何解析

响应体已经携带足够信息，无需按渠道特判：

- 入场返回 `session.playerId`；
- 结账返回 `playerSettlement.playerId`。

Bot 渠道用 `identity` / `identityKey`（平台身份、卡号）识别玩家，本身不含账号 id，但**响应里的 `session.playerId` 是全渠道统一的**，再由 `shop_player_accounts(shop_id, player_id)` 反查 `user_id` 即可定位该玩家的设备令牌。这正是让 Bot 渠道无需特殊处理的原因。

## 数据库

`migrations/0025_live_activity_push_tokens.sql` 新增 `live_activity_tokens`：

| 列 | 说明 |
| --- | --- |
| `shop_id` / `user_id` | 定位「哪个账号在哪家店」 |
| `activity_id` | iOS `Activity.id`；App 与 App Clip 是两个 target，同一玩家可能同时存在多个活动 |
| `token` | APNs 实时活动令牌（小写十六进制） |
| `environment` | `sandbox` / `production`，决定 APNs 主机 |
| `bundle_id` | 决定 `apns-topic`（App 与 App Clip bundle id 不同） |
| `session_id` | 该活动关联的场次；调度器成功结束后删除令牌，旧推送路径结账后置 `NULL` |
| `attributes_json` | 创建活动时的 `ActivityAttributes`，回存备查 |

唯一键 `UNIQUE(shop_id, user_id, activity_id)`：App 在令牌轮换后会重复上报，注册接口以 upsert 处理，不会产生重复行。

## 推送内容

`content-state` 的键名必须与 Swift 侧 `StoreVisitAttributes.ContentState` **逐字段一致**（`phase` / `startedAtUnix` / `endedAtUnix` / 可选的 `bill`）。旧版状态没有 bill 时仍可解码。ActivityKit 在无法解码时会静默丢弃推送，测试同时验证字段兼容与 4 KB 大小限制。

- 入场 → `event: "update"`，`phase: "active"`，`startedAtUnix` 取场次真实开始时间；
- 结账 → `event: "end"`，`phase: "ended"`，带 `dismissal-date`（60 秒后消失）。

`startedAtUnix` 是绝对时间戳，落锁屏后由 `Text(timerInterval:)` 在本地渲染，因此跨时区安全。

### 时间轴事件契约

REST 快照与 APNs `content-state.bill` 使用同一个 `activityBill()`，均返回 `previousEvent: { atUnix, label } | null`。这是可选扩展字段，旧客户端可以忽略，旧载荷没有该字段仍可解码。`asOfUnix` 仅是快照计算时间，不是时间轴起点。

实时活动的事件就是账单的事件：后端用同一份统一账单预览构建账单时间轴（`buildBillTimeline`），`billEvents()` 把每个事件点按账单的叫法命名为一行标签——开始计费、结束计费、切换计费规则、封顶结束、已封顶、新的一天；同一时刻有多种事件时按这个顺序取第一个，表示「现在」的点不是事件。除此之外只多一种节点：一个计费单位实际收费的时刻（标签「计费」；下一事件为「下次计费」），按联合结算后实收大于零的单位、以宽限规则（至少一分钟、至多一个单位，设备已操作时首单位立即收费）推出。

- 上一事件：现在之前最近的账单事件或收费时刻，同刻时账单事件的叫法优先。封顶在被挡下的那个单位开始时到顶，所以「已封顶」的时间是该单位的开始时间。
- 下一事件：各方案最近的下次收费（`nextTimePricingEvent`）、规则边界（按边界后的规则命名：同名为「新的一天」，另一条为「切换计费规则」，没有规则为「结束计费」），以及被封顶方案的封顶结束时刻，取最早者。预载下一节点时，若那时的账单会新出现事件（例如一次收费其实被封顶挡下），下一事件改用该事件的叫法，如「已封顶」。
- 封顶状态与账单一致：账单把某方案画成封顶中（虚线）时它就不再有收费倒计时，下一事件是封顶结束；判断依据是联合结算后的实收，而不是单个收费项报价里的 `intervalCapReached`。全部方案都封顶时 `remainingToCapCents` 为 0；否则取仍在计费的方案所在跨方案封顶窗口中最紧的剩余额度（上限 − 此前已计 − `amountApplied`）。

示例：

```json
{
  "amountCents": 600,
  "planLabel": "标准方案（日间）",
  "previousEvent": { "atUnix": 1790000000, "label": "计费" },
  "nextEvent": { "atUnix": 1790001800, "label": "下次计费" },
  "asOfUnix": 1790000600,
  "billable": true
}
```

## 配置

平台入口为 `packages/server/src/worker.ts`，导出 Hono 应用和 `LiveBilling` Durable Object。`wrangler.jsonc` 声明 `LIVE_BILLING` SQLite namespace 和 `live-billing-v1` 类迁移；生成的部署配置继承它们。上线前计费数据库须已应用 `0028_pricing_versions.sql`。未配置绑定时保留原 start/end 推送行为。

## 金额与倒计时更新

每个店铺／玩家一个 Durable Object，只为已注册实时活动的玩家安排任务。保存玩家标识和修订号，金额与方案始终从真实未结账会话及其锁定版本读取，不修改账单和资产。Alarm 到期后使用现有统一账单预览计算，发送摘要，再安排下一边界；没有全店轮询，也不挂常驻 Future。

`nextTimePricingEvent` 复用计价引擎的优先级、时区、分钟取整、宽限和分段起点，给出每个方案的下次收费和规则边界；账单画成封顶中的方案不再产生收费倒计时。收费倒计时表示计费规则节点；金额仍由统一预览确认，因此优惠抵消金额增长时也可能保留该规则节点。同刻的多个节点按上文账单事件的顺序取一个标签。

### 预载下一节点

REST `live-activity/bill` 与 start/update 的 `content-state` 增加可选 `nextBill`，结构与当前 `bill` 相同；旧客户端忽略它，旧响应缺失时新客户端仍沿用过期显示。后端以当前账单的 `nextCheckAt` 为时间，通过同一个只读结账预览引擎再计算一次，最多预载一个、八小时内的已知节点；不递归计算未来时间轴，不扣余额、不结束会话。`nextBill.asOfUnix` 等于当前 `bill.nextEvent.atUnix`。未来预览失败时只省略预测，当前账单仍可用。

`stale-date` 向上取整到节点所在的整秒，不能早于真实节点。新客户端在系统切换 `isStale` 后显示预载金额、上一事件及后续倒计时，沿用正常状态及金额显示，不添加“预计”或近似符号。不需要 App 在前台、定时器或节点时刻的新推送。优惠、资产、子会话或人工调整等业务变更通过高优先级更新覆盖预载内容，已保存的结账结果优先。已停止计费或已付款的活动不带、也不启用预测。

每份载荷只能跨一个节点，不能无限自动计费；后续低优先级更新负责补充新的 `nextBill`。若补充长期未到，界面保留最后一次预载金额，不再自行增加金额；预载后的倒计时最多到零。系统触发 stale 展示也不能承诺秒级时效。普通定时刷新继续使用原额度及低优先级，业务变更与付款结束使用独立于普通额度的有界投递。

入场、子会话增减、麻将开局／离桌、取消宽限的设备操作、结账和账单预览均触发同步。普通 GET 概览不触发重新计费。短时间事件合并，内容不变不重复推送；批量结账逐玩家同步。新增子会话更新原活动，不另开一份入场活动。回调读取最新状态，修订号变化则放弃旧结果，推送失败通过 Alarm 重试；成功令牌分别记账去重。结账的最终金额读取该会话对应的已保存 checkout，避免混入后一次入场的账单。

**费用风控（服务端强制）**：每个店铺／玩家的普通账单刷新 DO Alarm 至少间隔 60 秒；采用持久化令牌桶，允许最初 4 次短间隔刷新，随后以每 5 分钟一次的速度补充额度。判断依据是普通账单刷新的实际执行次数，**即使账单确实每分钟变化、价格规则每分钟计费或恢复请求 revision 不断增加，也不能绕过额度**。已保存的结账结果对应的结束通知独立于普通 60 秒间隔和令牌桶，不再共享每玩家 15 分钟冷却；同一玩家短时间内多次入场、结账，各活动均可及时结束。未付款活动的定时更新和 GET 恢复仍受原额度约束；经鉴权成功的业务变更独立触发高优先级更新，以及时替换预载内容。每条活动的相同内容最多尝试 6 次，失败退避为 5、10、20、40、60 秒，业务变更和结束推送的退避不再被普通额度延长；重复业务或结账通知、DO 休眠重启均不会重置重试次数或提前再次发送，成功后删除令牌。同一 Alarm 最多检查 16 个 Token 并发送 4 次 APNs。活动注册在每个店铺／用户下限制最多 4 条，且注册与注销共享每分钟 5 次的速率限制。最后一个活动注销后仍保留极小的频率预算，防止反复注册清空风控。维护状态的 Alarm 使用指数退避，最长等待 8 小时后停止。`refresh()` 会保留已存在的较早 Alarm，避免高频业务刷新不断推迟任务，也不会覆盖维护期间的退避时间；异常或未来时间戳的活动令牌按无效 Token 清理，以防产生超长寿命的自动唤醒。限流会让极端一分钟计费配置的远端账单更新延迟，但不会改变真实计费和结算；客户端不得把 Live Activity 推送频率当作计费频率。

普通定时账单／注册／GET 恢复的 `event=update` 使用 APNs 优先级 `5`；成功的业务变更（入场、子会话、优惠／资产、设备操作、麻将上／离桌等）及开始、付款结束使用 `10`。业务变更合并到一秒后的 Alarm，内容不变不重复发送；失败保留高优先级并按原上限重试，成功后恢复普通定时策略。这样定时计费无需持续消耗系统高优先级预算；Apple 的高优先级配额和送达时机仍由系统决定。服务端记录 `live_activity_push` 的事件种类、优先级、APNs 接收结果及失败状态／标准原因，不记录推送令牌、用户标识或任意响应内容；APNs 接收成功不等于设备已显示。

本地请求只用于初次创建或恢复已过期内容，也会恢复后台调度。Swift 不复刻计费引擎，倒计时通过系统时间组件持续显示。到下一次检查时间设为 stale；若有匹配的预载快照则切换，否则隐藏旧倒计时，保留账单金额和时间。全部会话关闭但尚未付款时保留活动，设置 `endedAtUnix` 停止计时并显示“待结账”；成功付款后再结束活动。推送受系统与网络影响，不保证准点到达。无令牌或活动已超过八小时则清理调度状态。

验证：`bun test packages/core/test/live-pricing-event.test.ts`（下次收费与规则边界）、`packages/server/test/shop-billing-routes.test.ts`（事件按账单命名、预载下一节点）以及 `packages/server/test/live-billing-*.test.ts` 与 `live-activity-*.test.ts`（Durable Object Alarm、APNs 暂时失败重试、金额去重、结账和令牌清理）。

| 变量 | 说明 |
| --- | --- |
| `APNS_KEY_ID` | Apple 开发者后台的 APNs Key ID |
| `APNS_TEAM_ID` | Team ID（本项目为 `XKKMJBTHX5`） |
| `APNS_PRIVATE_KEY` | `.p8` 私钥内容，**必须**用 `wrangler secret put` 注入，不可入库或提交 |

三个变量**全部可选**：任一缺失时推送整体退化为 no-op，因此本地与 beta 环境不需要 Apple 凭据。`APNS_PRIVATE_KEY` 通过 `wrangler secret put APNS_PRIVATE_KEY --config wrangler.generated.jsonc` 设置。

```sh
wrangler secret put APNS_PRIVATE_KEY --config wrangler.generated.jsonc
```

## 可靠性与边界

| 场景 | 行为 |
| --- | --- |
| App 被强杀 | 服务端直接推 APNs，不依赖 App 存活（本功能的核心价值） |
| App 从未为该店创建过活动 | 没有令牌，无法凭空创建活动；记录日志并跳过 |
| APNs 返回 `410 Unregistered` | 活动已消失（被划掉 / App 被删除），删除该行，避免继续推给死令牌 |
| APNs 返回 `429` / `503` | 记为失败并记录日志，不影响计费 |
| 结账失败 | 仅在响应 2xx 时推送，失败绝不发送 `end` |
| 推送耗时 | 用 `executionCtx.waitUntil`，绝不阻塞结账响应；无执行上下文时退化为后台任务 |
| 响应体被埋点消费 | 用 `response.clone()` 读取，保证调用方仍能拿到完整响应体（有单测保护） |
| 跨店 | 令牌按 `shop_id` 查询，B 店操作不会推送到 A 店的活动 |
| 登出 | App 调用 `unregister` 并结束活动，避免残留推送 |
| 用户关闭实时活动权限 | 本地不会创建活动，因而没有令牌，服务端自然跳过 |

## 已知前置条件

1. **`moe.neri.hinatago`、`moe.neri.hinatago.prism` 及两个 widget extension 的 App ID 必须已在 Apple Developer 后台启用 Push Notifications 能力**，且描述文件包含 APNs 权限。这是代码无法绕过的前置条件。
2. 验收需要**真机**：模拟器不支持实时活动推送。
3. App Clip 的实时活动生命周期受系统限制更严（Clip 卸载 / 过期），其令牌更易失效，依赖 `410` 清理路径。

## 测试

`packages/server/test/live-activity-compat.test.ts`、`live-activity-push-flow.test.ts`、`shop-billing-routes.test.ts` 、`live-billing-alarm-budget.test.ts` 与 `live-billing-terminal-delivery.test.ts` 覆盖：

- `content-state` 键名与 Swift `ContentState` 一致（防止静默丢弃回归）；
- ES256 Provider JWT 真实签名并用公钥验签、缓存与轮换；
- APNs 请求头、sandbox / production 主机切换、App 与 App Clip 的 topic；
- 各渠道入场 / 结账路径识别，以及只读接口不触发推送；
- 三种响应体形状下的 `playerId` 与场次提取；
- 令牌注册 upsert、解绑、越权与非法输入拒绝（真实 D1，经 HTTP 路由）；
- **端到端**：扫码入场 → App Clip 令牌注册 → 实际 DO 初次更新 → 六种真实 HTTP 结账路由 → 约一秒后可执行的 Alarm → 格式正确、最终金额准确的 `end` 推送，且重复结账不重复派发；
- 普通额度耗尽且之前刚结账时，六种渠道仍能发送最终状态；
- 同一玩家连续两次结账、DO 重启后的 5 秒重试，以及重复通知不突破最多 6 次的发送限制；
- 普通更新优先级为 `5`，业务变更与结束通知为 `10`；普通额度耗尽时业务变更仍投递，重复通知不提前重试；
- 两分钟节点的预载金额与到点后的真实预览一致，预测不扣余额、不结账；start/update 载荷保持 4 KB 内，停止计费与付款结束不携带预测；
- **结账失败时绝不推送**。

运行：

```sh
bun test packages/server/test/live-activity-*.test.ts packages/server/test/live-billing-*.test.ts packages/server/test/shop-billing-routes.test.ts
bun run typecheck
```

## 客户端对应实现

`hinata_go` 侧（均在原生 Swift，无 Dart 桥接）：

- `ios/LiveActivityShared/StoreVisitLiveActivityManager.swift`：`pushType: .token`，监听 `pushTokenUpdates` 上报令牌，结束与登出时解绑；
- `ios/PrismClip/PrismAPI.swift`：`registerLiveActivity` / `unregisterLiveActivity`；
- `ios/PrismClip/MachineLoginViewModel.swift`：登出时调用 `unregisterAllPushTokens()`；结账后经由 `reconcile(session: nil, ...)` 查询活动所属会话的结算结果，再结束活动并解绑。

验证：`sh test/native/run-prism-visit-check.sh`。

## 客户端恢复与注销

普通前台账单预览仍由后端触发同步，不直接覆盖活动内容。客户端仅在活动缺失/内容过期时拉取摘要；App 内结账成功直接复用结账响应结束活动；原活动不再出现在 activeSession 时，先复用页面已取得的最近结算单，按 settlements 中的 sessionId 精确匹配。只有缺少匹配且完整的结算数据时，才使用 `live-activity/bill?sessionId=...` 查询该活动所属会话。接口校验店铺及玩家归属。确认已付款才以已保存 checkout 金额、sessions.ended_at 结束活动；查询失败保留原活动，关闭未付款仍保持 active。后台结束推送同样使用实际停止时间，不将等待付款的时间计入时长。本次不改变付款失败继续计费的业务规则。

客户端注销先等待启动令牌 DELETE 及活动令牌注销，再调用 auth/logout，并立即移除当前部署的本地活动。恢复、去重和退出清理不影响另一部署同编号的活动。注销网络失败会记录日志，令牌仍可能需要后续 APNs 失效清理。

新增回归覆盖：按会话恢复最终金额/停止时间、后一次入场不污染前一次结算、关闭未付款状态、原生注销顺序和 DELETE 方法，以及生产 Swift manager 在请求失败时保留活动。
