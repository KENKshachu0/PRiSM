# PRiSM Next API 参考手册

API 由 `packages/server-hono` 提供实现，本文档和服务端路由是客户端集成的接口依据。

所有成功的响应均返回 JSON 格式的视图模型（View Model），而非原始的数据库行数据。发生异常时，错误响应的格式如下：

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "易读的错误说明文本。"
  }
}
```

## 身份认证 (Authentication)

| 适用范围 | Token 形式 | 额外必需 Header |
| --- | --- | --- |
| 玩家 (Player) | `/rpc/player-auth/login/by-identity` 返回的玩家会话 Token | 无 |
| 员工 (Staff) | `/rpc/admin/login` 返回的管理员会话 Token | 无 |
| 机器人/店内入口 (Integration) | 生成的 Integration API Token | 无 |
| 机器软件接入 (Machine) | 生成的 Machine API Token | 无；连接后在 WebSocket `hello` 消息中声明 `machineId` |

员工角色划分为 `owner`、`manager` 和 `viewer`。员工写路径操作通常需要 `owner` 或 `manager` 角色；`viewer` 角色仅有权调用读路由。员工用户管理路由（例如员工增删和重置密码）需要 `owner` 角色。

系统初始化开箱即用向导（OOBE）需要通过数据库存储状态。首次启动时应依次调用 `/rpc/setup/status` 和 `/rpc/setup/install`。安装结果中的 `apiTokens` 与员工 API Token 视图保持同一字段语义，包含 ISO 8601 格式的 `createdAt`；完整 `token` 只在本次安装结果中返回一次。

员工可创建的 API Token 角色只有 `integration` 和 `machine`。`bot`、`agent` 和 `player` 不再是持久化 API Token 角色；已有开发库升级时，`bot` 会迁移为 `integration`，`agent` 会迁移为 `machine`，旧 `player` API Token 会被移除。浏览器玩家端不得再使用共享 Token 加 `X-PRiSM-Player-Id` 的方式指定玩家；玩家身份必须由会话 Token 解析得到。

## 外部身份格式

机器人、店内入口和未来玩家登录接口在按外部身份查找玩家时，统一使用结构化身份对象：

```json
{
  "identity": {
    "provider": "qq",
    "subject": "123456"
  }
}
```

`provider` 会去掉首尾空白并转成小写，`subject` 会去掉首尾空白但保留原始内容。为了保留 prism-neo 时代机器人调用的便利性，需要输入单个字符串的地方也可以使用 `TYPE:subject` 简写，例如 `QQ:123456`、`aime:0111222333` 或 `telegram:abc:def`。解析时只按第一个冒号分隔，因此 subject 内部可以继续包含冒号。缺少冒号、provider 为空或 subject 为空时，接口应返回 `INVALID_EXTERNAL_IDENTITY`。

## 公共接口 (Public)

| 请求方法 | 路由路径 | 接口用途 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查。 |
| `GET` | `/version` | 查询后端发布版本与构建 Git 提交号；无需认证。 |
| `GET` | `/admin` | 后台管理客户端的部署提示页，正式 UI 由 `packages/prism-dashboard` 构建部署。 |
| `GET` | `/rpc/setup/status` | 查询系统是否已完成初始化开箱配置。 |
| `POST` | `/rpc/setup/install` | 初始化首个 owner 员工、店铺设置、本位余额资产和 API 密钥。 |
| `POST` | `/rpc/admin/login` | 管理员账号登录，创建管理员会话 Token。 |
| `POST` | `/rpc/admin/logout` | 验证当前管理员 Token 并撤销对应的服务端会话；成功返回 `204`。 |

## 玩家 RPC 接口 (Player RPC)

玩家端先通过已绑定外部身份登录：

| 请求方法 | 路由路径 | 接口用途 |
| --- | --- | --- |
| `POST` | `/rpc/player-auth/login/by-identity` | 通过已绑定的 QQ、Aime、扫码身份等创建玩家会话；返回 `session.token` 和玩家基本信息。 |

当前版本的登录接口是“可信入口第一版”：它只登录已经绑定的身份，不自动注册玩家。后续 OAuth、短信或扫码确认可以接到同一张 `player_sessions` 表，不需要改变 `/rpc/player/*` 的玩家自助接口。

| 请求方法 | 路由路径 | 接口用途 |
| --- | --- | --- |
| `GET` | `/rpc/player/me` | 查询玩家个人信息、可用钱包总览和当前的活跃场次。 |
| `GET` | `/rpc/player/assets` | 查询当前可用且可显示的资产持有及历史流水记录。 |
| `GET` | `/rpc/player/sessions/history` | 查询历史结账场次。 |
| `GET` | `/rpc/player/sessions/:sessionId/history` | 查询指定场次的收费明细项及折扣调整项。 |
| `POST` | `/rpc/player/session/start` | 启动包时结算场次。 |
| `POST` | `/rpc/player/device-commands` | 申请设备动作。动作使用明确类型：`door.open`、`power.on`、`power.off`、`ac.set_temperature`、`coin`、`aime.scan`，并通过 `target.kind` 区分设施设备和游戏机器。 |
| `POST` | `/rpc/player/checkout/preview` | 预览当前场次结账费用，不关单。 |
| `POST` | `/rpc/player/checkout/confirm` | 确认当前场次结账，扣减余额并关单。 |
| `POST` | `/rpc/player/redeem` | 输入 CDK 兑换码兑换礼物。 |
| `POST` | `/rpc/player/business-items/:businessItemId/purchase` | 购买前台发布的非计时服务商品（如门票、预约费等），要求处于活跃会话内，并即时扣减余额。 |
| `GET` | `/rpc/player/business-item-orders` | 列出该玩家本人的非计时服务购买履约订单。 |

### 玩家接口调用示例

启动计费场次：

```bash
PLAYER_TOKEN=$(
  curl -s -X POST http://localhost:8787/rpc/player-auth/login/by-identity \
    -H "Content-Type: application/json" \
    -d '{"identity":{"provider":"qq","subject":"123456"}}' \
  | jq -r '.session.token'
)

curl -X POST http://localhost:8787/rpc/player/session/start \
  -H "Authorization: Bearer $PLAYER_TOKEN"
```

申请投币一次：

```bash
curl -X POST http://localhost:8787/rpc/player/device-commands \
  -H "Authorization: Bearer $PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"coin","target":{"kind":"game_machine","id":"mai-1"},"payload":{"count":1}}'
```

设备动作的目标分两类：

- `facility`：门禁、电源、空调等设施动作，执行器可以是 `home_assistant`、`ttlock` 或设施网关。
- `game_machine`：投币、Aime 扫描等游戏机器软件动作，执行器为 `machine_ws`，由对应机器的在线 WebSocket 连接实时接收。

玩家发起的 `coin`、`aime.scan`、`power.on` 和 `power.off` 必须已有活跃计费 session；`coin` 还会检查投币冷却时间。受信任的 Bot 集成可为 `power.on/off` 请求附加 `staffOverride: true`，该请求会记录为员工动作并不受玩家 session 限制。Koishi 的 `powerCommandsAdminOnly` 配置只限制 `/off`；`/on` 仍要求玩家已入场。

设施动作示例：

```bash
curl -X POST http://localhost:8787/rpc/player/device-commands \
  -H "Authorization: Bearer $PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"power.on","target":{"kind":"facility","ref":"舞萌一号机"}}'
```

设施动作的请求目标必须使用 `target.ref`，只接受后台设备 `name`、任意一个 `alias` 或批量目标 `all`，不接受 `target.id`、Home Assistant entity ID 或 TTLock `lockId`。后端会先解析设备引用再创建并保存命令：Home Assistant 命令的 `action.deviceId` 是规范 entity ID，TTLock 命令的 `action.deviceId` 是后台门锁映射的内部 ID；批量动作没有单一设备 ID，返回 `deviceId: null` 和 `target: { "kind": "facility", "all": true }`。

当后台设置中配置了 Home Assistant 连接时，`power.on`、`power.off` 和 `ac.set_temperature` 直接调用 Home Assistant；未被 TTLock 映射的 `door.open` 仍可调用 HA 的 `unlock`。匹配到 TTLock 门锁映射的 `door.open` 会调用 TTLock Cloud `/v3/keyboardPwd/add` 创建 8 位随机临时密码，默认有效期 3 分钟；TTLock 认证信息和门锁映射分别存于 `devices.ttlock_connection`、`devices.ttlock`。执行成功的 TTLock 动作会在本次响应的 `action.payload.temporaryPassword` 返回密码，不写入命令审计记录。`power.on/off` 会映射到实体所属 domain 的 `turn_on/turn_off`，`ac.set_temperature` 映射为 `climate.set_temperature` 并传递 `payload.temperature`。执行成功的设备动作会在 `action.payload.deviceLabel` 中返回后台设备 `name`；`all` 会对后台注册的所有 Home Assistant 设备逐个执行电源动作，并返回 `payload.deviceLabel: "所有设备"`。

兑换礼物 CDK：

```bash
curl -X POST http://localhost:8787/rpc/player/redeem \
  -H "Authorization: Bearer $PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code":"PRISM-2026"}'
```

兑换响应中的 `grantedAssets` 只包含本次兑换实际增加且当前可向玩家展示的资产，使用 `assetName` 返回后台配置的展示名称，`quantity` 是本次增加量。兑换后的完整可用持有量放在 `currentHoldings`；响应不再提供含义重复的 `holdings` 别名。

所有玩家当前资产读取统一执行同一组规则：持有数量必须大于 0，持有记录和关联资产定义都必须已生效且未过期，资产定义必须存在且未归档，玩家视图还会排除 `hiddenFromPlayer` 项。钱包、资产列表、兑换与结账回执均使用该统一结果；员工审计接口仍可查看过期、归档和隐藏记录。

员工读取 `/rpc/staff/players/:playerId/assets` 时仍会得到全部当前持有记录，但每条 holding 由同一个统一入口附加 `availability`（`available` / `unavailable`）和 `unavailableReasons`。原因码覆盖数量非正、持有记录未生效或已过期、资产定义缺失、归档、未生效或已过期；Staff Web 只负责筛选和翻译原因，不自行按浏览器时间重新判断。该读取不会回写或清理数据库。

## 员工后台 RPC 接口 (Staff RPC)

| 请求方法 | 路由路径 | 接口用途 |
| --- | --- | --- |
| `GET` | `/rpc/staff/me` | 验证当前员工 Token，返回角色身份和读写权限。 |
| `GET` | `/rpc/staff/users` | (Owner 专用) 获取系统员工列表。 |
| `POST` | `/rpc/staff/users` | (Owner 专用) 创建新员工账号。 |
| `PATCH` | `/rpc/staff/users/:staffUserId` | (Owner 专用) 修改员工昵称、角色以及启用/禁用状态。 |
| `POST` | `/rpc/staff/users/:staffUserId/password` | (Owner 专用) 重置指定员工账号的密码。 |
| `GET` | `/rpc/staff/api-tokens` | (Owner 专用) 查看外部接入密钥列表，不返回完整密钥。 |
| `POST` | `/rpc/staff/api-tokens` | (Owner 专用) 创建机器人/店内入口或机器软件接入密钥，完整密钥只在创建结果中返回一次。 |
| `POST` | `/rpc/staff/api-tokens/:tokenId/revoke` | (Owner 专用) 撤销指定外部接入密钥。 |
| `GET` | `/rpc/staff/players` | 获取玩家列表，附带钱包余额总额、活跃会话摘要和外部身份绑定摘要。 |
| `POST` | `/rpc/staff/players` | 创建新玩家，支持在创建时直接给予初始化资产。 |
| `PATCH` | `/rpc/staff/players/:playerId/status` | 设置玩家状态（`active` / `disabled` / `banned`）。 |
| `POST` | `/rpc/staff/players/:playerId/identities` | 绑定玩家外部物理卡或 QQ 身份。 |
| `DELETE` | `/rpc/staff/players/:playerId/identities/:provider/:subject` | 删除玩家的某个外部身份绑定；删除后该 QQ、卡号或扫码身份不再自动指向此玩家。 |
| `POST` | `/rpc/staff/players/:playerId/session/start` | 管理员为玩家开启一个计费 session；同一玩家可同时拥有多个平级 active session，请求体可带 `pricingConfigIds` 指定这条计时使用哪些计费方案。 |
| `GET` | `/rpc/staff/players/:playerId/assets` | 检查并审计指定玩家的资产持有和变更流水。 |
| `POST` | `/rpc/staff/players/:playerId/assets/grants` | 给玩家赠送/分发资产（货币、道具、月卡等）。 |
| `POST` | `/rpc/staff/players/:playerId/assets/adjustments` | 按 `holdingId` 精确调整/扣减/ revoke 某条玩家持有记录，避免同类资产的不同有效期记录互相混淆。 |
| `POST` | `/rpc/staff/players/:playerId/wallet/adjustment` | 按 `amount` 与 `reason` 调整玩家钱包；正数增加充值余额，负数执行余额冲正。 |
| `GET` | `/rpc/staff/players/:playerId/sessions/history` | 查询该玩家的历史场次。 |
| `GET` | `/rpc/staff/players/:playerId/sessions/:sessionId/history` | 查询玩家某次结算的账单明细。 |
| `GET` | `/rpc/staff/players/:playerId/redeem-records` | 查询该玩家的兑换记录，返回兑换码、礼物名称和兑换时间，用于玩家档案审计。 |
| `POST` | `/rpc/staff/players/:playerId/checkout/preview` | 预览该玩家所有 active session 和未结 closed session 的统一结算结果；不关单、不扣款。 |
| `POST` | `/rpc/staff/players/:playerId/checkout/confirm` | 关闭该玩家所有 active session，并统一结算所有未结 session。 |
| `POST` | `/rpc/staff/players/:playerId/checkout/override` | 后台特权改单结算：指定最终金额与改单备注，存入审计项。 |
| `POST` | `/rpc/staff/players/:playerId/sessions/:sessionId/stop` | 只停止指定 session 的计时，保留为待结算，不立即扣款。 |
| `GET` | `/rpc/staff/live-players` | 获取现场页玩家聚合读模型：每名在场玩家一行，包含钱包、在场时间、预计应付、平级 session 明细，以及按锚定封顶窗口分组的 `globalCapWindows`。session 同时保留紧凑的 `pricingCharges` 摘要，并提供带实际时段解释的 `pricingSegments`。 |
| `GET` | `/rpc/staff/sessions/active` | 获取全场当前的活跃场次。 |
| `POST` | `/rpc/staff/sessions/active/checkout` | 一键结账/清理全场所有活跃场次。 |
| `GET` | `/rpc/staff/pricing-effects` | 列出可绑定到资产的计费效果，如免时费、固定抵扣或比例折扣。 |
| `PUT` | `/rpc/staff/pricing-effects/:effectId` | 新增或编辑计费效果，可设置作用范围、每日次数、最低消费门槛（`minSubtotal`）、生效时间、过期时间，以及适用的计时名称、计费方案和计费时段规则。 |
| `POST` | `/rpc/staff/pricing-effects/:effectId/archive` | 软归档计费效果，历史资产引用保留但新配置不可继续使用。 |
| `POST` | `/rpc/staff/pricing-effects/:effectId/restore` | 恢复已归档计费效果。 |
| `GET` | `/rpc/staff/asset-definitions` | 列出资产定义的清单。 |
| `PUT` | `/rpc/staff/asset-definitions/:assetType/:assetCode` | 新增或编辑某项资产定义，可绑定计费效果并设置资产定义有效期。 |
| `POST` | `/rpc/staff/asset-definitions/:assetType/:assetCode/archive` | 软归档某项资产定义（保护历史引用不丢失）。 |
| `POST` | `/rpc/staff/asset-definitions/:assetType/:assetCode/restore` | 恢复已归档的资产定义，使其恢复可用。 |
| `GET` | `/rpc/staff/presents` | 查看所有礼物定义，包括已归档的定义和有效期。 |
| `POST` | `/rpc/staff/presents` | 创建一个礼物定义，可包含多项发放内容，每项内容可单独设置有效期。 |
| `POST` | `/rpc/staff/presents/:presentId/archive` | 软归档礼物。 |
| `POST` | `/rpc/staff/presents/:presentId/restore` | 恢复已归档的礼物。 |
| `GET` | `/rpc/staff/business-items` | 查看非计时商品定义列表。 |
| `POST` | `/rpc/staff/business-items` | 发布非计时商品项目（如门票、服务、预约）。 |
| `POST` | `/rpc/staff/business-items/:businessItemId/archive` | 软归档商品项目。 |
| `POST` | `/rpc/staff/business-items/:businessItemId/restore` | 恢复已归档商品项目。 |
| `GET` | `/rpc/staff/business-item-orders` | 查看全场玩家的商品订单列表。 |
| `POST` | `/rpc/staff/business-item-orders/:orderId/fulfill` | 确认订单核销履行（Fulfill）。 |
| `POST` | `/rpc/staff/business-item-orders/:orderId/cancel` | 取消已支付商品订单，不执行物理删除，不包含自动退款。 |
| `GET` | `/rpc/staff/redeem-codes` | 获取 CDK 码清单，返回每个码绑定的礼物、使用上限、已使用次数，以及已使用码的兑换人和兑换时间。已使用次数由 `redeem_records` 聚合而来，因此迁移过来的已兑换记录会在 Staff Web 中显示为已用。Staff Web 不会把全量结果一次性铺开，只展示汇总和最近少量预览，并支持按绑定礼物和使用状态筛选；大量码的查询/导出应走专门筛选或批次工具。 |
| `POST` | `/rpc/staff/redeem-codes` | 生成单个 CDK。 |
| `POST` | `/rpc/staff/redeem-codes/batch` | 批量生成 CDK 兑换码，可指定前缀、数量、礼物、可用次数和有效期。 |
| `POST` | `/rpc/staff/redeem-codes/:codeId/revoke` | 作废指定的 CDK 兑换码。 |
| `GET` | `/rpc/staff/pricing-configs` | 获取系统已创建的计费规则配置，包含按时计费和固定收费方案。 |
| `GET` | `/rpc/staff/pricing-extensions` | 获取已注册的运行时插件扩展（展示其需要资产的状态）。 |
| `POST` | `/rpc/staff/pricing-configs` | 创建新的计费方案规则；`time.priority` 使用多条 `provider.rules`，`time.cap` 使用封顶 `provider.rules` 与 `provider.includedPricingConfigIds`，`charge.fixed` 使用 `provider.label` 和 `provider.amount`。 |
| `PATCH` | `/rpc/staff/pricing-configs/:pricingConfigId` | 修改现有计费方案；计费方案类型不可在更新时切换，后台会按原方案类型校验并提交完整 provider 内容。 |
| `POST` | `/rpc/staff/pricing-configs/:pricingConfigId/archive` | 软归档计费方案。 |
| `POST` | `/rpc/staff/pricing-configs/:pricingConfigId/restore` | 恢复已归档计费方案（默认处于禁用状态，需重新开启）。 |
| `GET` | `/rpc/staff/pricing-configs/:pricingConfigId/timeline?date=YYYY-MM-DD` | 获取指定日期下该方案的可视化 24 小时时间轴分段明细。 |
| `POST` | `/rpc/staff/pricing-timeline/preview` | 发送未保存的计费规则草稿，计算并预览其 24 小时时间轴；普通计费草稿发送 `pricing`，全局封顶草稿发送 `priceCap` 与可选 `includedPricingConfigIds`。 |
| `GET` | `/rpc/staff/settings` | 读取店铺通用和硬件设置。 |
| `PUT` | `/rpc/staff/settings` | 更改店铺配置、投币冷却时间、新用户注册礼物包、Home Assistant、TTLock 和 Hinata IO 设置；`registration.defaultPresentId` 填现有礼物 ID，填 `null` 表示关闭。 |
| `GET` | `/rpc/staff/device-states` | 获取设施设备上报状态，用于门禁、电源、空调、灯光等 Home Assistant 或设施网关视图。 |
| `GET` | `/rpc/staff/machine-connections` | 获取游戏机器软件的 WebSocket 在线状态、能力列表、连接时间、最后心跳和断开时间。 |
| `POST` | `/rpc/staff/device-actions` | 员工从后台直接发起设备动作。设备看板使用它发送 `power.on` / `power.off` / `door.open` / `ac.set_temperature` / `coin` / `aime.scan`，请求体为 `{ type, target: { kind, id }, payload? }`，返回 `{ action }`。 |
| `GET` | `/rpc/staff/device-commands?limit=50` | 审计近期所有硬件发送指令的流水。失败命令会在 `payload.executorFailure.message` 中返回执行器原因，设备看板会直接展示。 |
| `GET` | `/rpc/staff/reports/summary?from=<iso>&to=<iso>` | 查询特定时段内的收入、开单数、分发道具数和投币次数。 |
| `GET` | `/rpc/staff/reports/settlements?from=<iso>&to=<iso>&limit=50&offset=0` | 分页查询特定时段内结账流水；返回 `settlements` 和 `{ limit, offset, hasMore }`。 |
| `GET` | `/rpc/staff/reports/players?from=<iso>&to=<iso>&limit=20&offset=0` | 分页查询特定时段内玩家消费贡献榜；返回 `players` 和 `{ limit, offset, hasMore }`。 |

已归档的资产定义、计费效果、礼物、商品项目和计费配置都会保留供历史账单与审计视图查阅。新员工赠送和新礼物不能使用已归档或不在有效期内的资产定义；已归档或过期的礼物不能被兑换；兑换码过期也会拒绝兑换。礼物过期但兑换码没过期、礼物没过期但兑换码过期，都会无法兑换；礼物和兑换码都有效但礼物内容过期时，兑换会成功记录，但过期内容不会到账。现有的兑换码、商品项目、插件和账本历史流水保持可读。已归档的资产定义、计费效果、礼物、商品项目和计费配置可以从 Staff Web 还原；已归档计费方案允许编辑并保存到原记录，但会继续保持归档和禁用，直到员工显式还原并开启。错误的草稿规则会从当前编辑列表中物理移除。导入的礼物授予日期会在仓储层恢复为 `Date | null`，避免旧 JSON 字符串破坏员工接口。导入的提供商有效负载可能仍包含退役的时间规则行或整段日期时间范围，以供迁移上下文使用；结算报价、会话启动营业时间验证、已启用配置验证和时间轴渲染会按领域规则处理这些历史行。

员工用户因审计需求而被保留。禁用员工用户可阻止登录，但会保留旧场次、指令和资产操作记录可读。PRiSM 会拒绝禁用或降权最后一名制造的所有者（owner）。

现场运营页以玩家为一级对象。`/rpc/staff/live-players` 会把同一玩家名下的多个未结 session 聚合为一行，并把每个 session 作为平级明细返回；这里的未结 session 包括 active session，以及已停止但 `payment_status = unpaid` 的 closed session。active session 的 `endedAt` 为 `null`，closed/unpaid session 会返回停止时写入的 `endedAt`，并且 `elapsedMinutes` 按 `startedAt` 到 `endedAt` 计算而不是继续滚到当前时间。若 session 没有标签，明细中的可选 `label` 字段会省略，而不是返回 `null`。`stayDurationMinutes` 按该玩家当前最久的未结 session 计算。session 明细保留来自当前玩家级结算预览的 `pricingCharges`，字段包含 `pricingConfigId`、`planName`、`ruleLabel` 和 `amount`，用于紧凑地说明这一条计时实际用了哪些计费方案。

同一条 session 的 `pricingSegments` 是可展开的逐段计费解释；每段包含 `pricingConfigId`、`planName`、`providerId`、`ruleId`、`ruleLabel`、`actualStartedAt`、`actualEndedAt`、`ruleTimeRange`、`amount`、`intervalCap` 和 `intervalCapReached`。`actualStartedAt` 与 `actualEndedAt` 是后端以 ISO 8601 UTC 时间戳（带 `Z`）返回的这次实际计费边界，不是仅有时钟的规则配置；`ruleTimeRange` 才是匹配规则的 `{ start, end }` 时钟范围。只有 `intervalCapReached = true` 时客户端才应显示该段的区间封顶状态，未达到时仍保留该段的真实金额而不显示封顶徽标。

玩家级 `globalCapWindows` 按全局封顶规则的锚定窗口分组，而不是按 session 或单次调整分组。每项包含稳定的 `key`、`capConfigId`、`capRuleId`、`ruleLabel`、窗口完整 ISO 8601 UTC 范围 `windowStartedAt` / `windowEndedAt`、`priceCap`、历史已计入金额 `paidBefore`、本次参与封顶前的 `currentAmount`、本次最终计入封顶的 `amountApplied`、`priceCapReached` 以及按 session/计费方案列出的 `contributions`。历史结账会进入同一个窗口的 `paidBefore`，因此客户端必须用这些 history-aware 值解释窗口余量；达到封顶时应展示 `priceCap` 这个封顶后的最终金额，未达到时展示 `amountApplied` 这个当前计入金额，不应把封顶产生的调整差额当成应收金额。`stop` 是独立的现场动作，只结束某个 session 的计时并保留待结算状态；停止后的 session 仍应显示在现场账单中，状态为已停止，直到玩家级 `confirm-all` 执行统一扣款。这样可以支持“音游计时 + 麻将服务叠加”等门店自定义计费方式，同时不把某个 session 设定成业务上的主从关系。

资产计费效果的 `config` 可包含 `applicableSessionLabels`、`applicablePricingConfigIds`、`applicableRuleIds` 以及最低消费门槛 `minSubtotal`（消费未达门槛时不触发减免）。结算时只有当前计时名称、费用项所属计费方案和费用项所属规则匹配且达到最低消费门槛时，效果才会作用到费用；针对特定方案的多张卡券叠加时，系统会跟踪并限制在目标费用项的剩余额度内，不会超出目标方案费用穿透到其他费用。资产持有量在扣减为 0 后不会在多场次结账中重复享受优惠；多张相同卡券生成的调整明细会带有持有唯一标识避免主键冲突；比例折扣按分保留两位小数；卡券有效窗口在开台时间或当前结算时间任一处于有效期内均可生效。后台 UI 会用中文控件生成这些配置，员工不需要手写 JSON。

员工计费时间轴预览使用与已保存计费配置相同的时间轴分段引擎。`time.priority` 草稿返回带 `pricing` 的收费时段，`time.cap` 草稿返回带 `priceCap` 的封顶时段；Staff Web 在保存前调用它来绘制草稿日时间轴，以便可视化预览与结账行为保持一致。预览圆环以接口返回的 `startMinute` / `endMinute` 为准，不在前端重新猜测跨日时段。未覆盖的时间轴段是非营业时间：玩家无法在其中启动计费场次，如果现有场次跨越这些分钟，结算将跳过这些分钟；全局封顶则只在覆盖到的分钟内限制选中方案合计。在可视化编辑器中，未保存的草稿规则可以直接移除；已保存规则会写回 `status: "archived"`，不再参与结算和时间轴，但保留规则 ID 供历史账单和计费封顶记录回查。迁移来的 `specificDates` 与 `dateTimeRange` 会随草稿预览和保存原样保留，避免节假日规则落到普通营业日；当需要停用整个方案而不破坏历史数据时，已保存的计费方案应使用归档/还原逻辑。

`time.priority` 规则允许负数 `unitPrice`，用于“在另一条 active session 上叠加抵扣”的场景。例如麻将 B 桌可用独立计时 session 按每小时 `-2` 生成负费用项，最终和玩家的标准入场计时一起统一结算。每个 session 的 `subtotal` / `total` 保留其真实正负计费贡献；后端只在汇总本次统一结账覆盖的全部 session、session 调整、全局封顶和整单调整后，将玩家级最终 `total` 限制为不低于 `0`。统一结账会持久化一条 `player_checkouts` 记录，并通过 `settlements.checkout_id` 关联各 session；营业汇总直接使用该批次的最终金额，不会提前把负数 session 单独归零，也不再依赖玩家和结账时间推断批次。

计费支持两级封顶。`time.priority` 规则里的 `pricing.priceCap` 仍表示方案内封顶，按玩家、计费方案、provider、规则和规则锚点累计；不同计费方案不会再意外共享方案内封顶。`time.cap` 是全局封顶时间轴，不产生费用项，只在后置优惠前对 `provider.includedPricingConfigIds` 中选中的普通按时计费方案合计做二次封顶。全局封顶历史写入独立的 `pricing_cap_history_entries`，按玩家、cap 配置、cap 规则和 cap 锚点累计；月卡、优惠券和手动改单不减少该历史。

金额相关字段均按 JSON number 处理，可以传小数，不会按整数截断。包括资产发放 `amount`、资产调整 `quantityDelta`、固定收费 `provider.amount`、时间计费 `pricing.unitPrice` / `pricing.priceCap`、全局封顶 `time.cap` 规则的 `priceCap`、计费效果 `value`、服务项目 `price`、改单最终金额以及结算返回的 `subtotal` / `total` / `chargeItems.amount` / `adjustments.amount`。分页 `limit`、使用次数、计费单位分钟、宽限分钟、优先级等字段仍为整数。

时间计费规则中的 `roundGraceMinutes`（宽限分钟）具有设备操作联动机制：如果玩家入场后未进行任何设备操作并于宽限期内退场，系统视为进店后未游玩离场，计费金额为 `0`；若玩家在场次期间发起并成功执行了除 `door.open` 门禁外的有效设备操作（包括 `coin` 投币、`aime.scan` 刷卡、`power.on` / `power.off` 开关电源、空调调温等），场次元数据会被自动打上 `deviceOperated: true`（或在结算时通过命令流水回溯补齐），使场次的首次进店免单宽限立即失效，强制收取至少 1 个计费单位的基础费用（即使时长不足 1 分钟或立即登出）；后续尾数取整宽限（例如 30 分钟单位计费时游玩 32 分钟仍按 1 单位计费）继续正常生效。

员工发放资产时，`mergeStrategy` 可为 `stack`、`extend-time` 或 `replace`；普通余额、券和道具发放默认使用 `stack`。为了兼容旧客户端和简单发放入口，`/rpc/staff/players/:playerId/assets/grants` 在请求体没有传 `mergeStrategy` 时会按 `stack` 处理。`extend-time` 必须提供正数 `durationMs`，用于从当前到期时间或当前时间继续延长；顶层可选 `reason` 会进入资产流水，空值才回退为 `staff.asset.grant`。

报表汇总字段 `assetGrantTotal` 为兼容旧响应名称而保留，但当前语义是所选时间段内正向资产流水的记录笔数，不是把余额、券和时长等不同单位的 `delta` 相加。Dashboard 因此显示为“资产入账笔数”。报表日期范围由店铺配置的 `store.timeZone` 解释后转换为 UTC；结账和玩家排行列表通过 `offset` 继续读取，不能把首屏条数当成完整结果。

结账预览接口返回包裹结构，而不是裸结算对象。`/checkout/preview` 返回 `{ settlementPreview, sessionPreviews, chargeItems, adjustments, checkoutAdjustments, pricingCapAdjustments, wallet, globalCapWindows }`，其中 `settlementPreview.sessionIds` 是本次统一结算覆盖的所有未结 session。确认结账接口返回 `{ playerSettlement, settlements, chargeItems, adjustments, checkoutAdjustments, pricingCapAdjustments, globalCapWindows, assetLedgerEntries, wallet }`；每条确认结果的 `settlements[].settlement` 还包含 session 的 `label`、`startedAt`、`endedAt`。`wallet` 固定为 `{ balanceBefore, balanceAfter }`：预览中的 `balanceAfter` 是按本次账单推算的余额，确认结账中的 `balanceAfter` 是扣款后的实际余额；客户端必须直接使用这两个数显示余额，不能再从 holdings 推导，两个值即使为 `0` 也始终存在。玩家、员工和 integration 路由共用 application 的同一结果类型，以上数组字段始终存在，空结果使用 `[]`，并把时间序列化为 ISO 8601。`adjustments` 包含 session、整单与封顶调整的合集；客户端应使用 `sessionPreviews[].adjustments`（预览）或从 `settlements[].adjustments` 中排除新分组字段里的同 ID 项（确认结账）识别 session 调整，使用 `checkoutAdjustments` 展示整单优惠或人工调整，使用 `pricingCapAdjustments` 计算封顶后的计费总价。`globalCapWindows` 按全局封顶规则锚定窗口分组，每项包含 `key`、`capConfigId`、`capRuleId`、`ruleLabel`、完整窗口范围 `windowStartedAt` / `windowEndedAt`、封顶金额 `priceCap`、历史已计入金额 `paidBefore`、本次参与金额 `currentAmount`、本次最终计入金额 `amountApplied`、`priceCapReached` 以及 session/计费方案级 `contributions`；客户端用这些值说明剩余封顶额度，不能把封顶差额显示成折扣或归属到某个 session。方案内区间封顶已经反映在计费段与费用项金额中，同样不能由金额差倒推为优惠。客户端需要先读取这些包裹字段再渲染账单，不应把整段响应直接当作 `settlementPreview` 解析。确认结账会按可用赠送余额和充值余额扣款；余额不足时返回 JSON 错误 `{ code: "INSUFFICIENT_BALANCE" }`，不会关单也不会扣款。机器人或自助入口应提示玩家充值或找店员改单，不应直接展示英文领域错误。

### 员工接口调用示例

向玩家赠送游戏代币 (Paid Balance)：

```bash
curl -X POST http://localhost:8787/rpc/staff/players/player-1/assets/grants \
  -H "Authorization: Bearer <admin-session-token>" \
  -H "Content-Type: application/json" \
  -d '{"grants":[{"assetType":"currency","assetCode":"paid","amount":1000,"mergeStrategy":"stack","activeAt":null,"expiresAt":null}]}'
```

添加一条工作日时间计费规则：

```bash
curl -X POST http://localhost:8787/rpc/staff/pricing-configs \
  -H "Authorization: Bearer <admin-session-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "kind":"time.priority",
    "name":"平日营业价格方案",
    "enabled":true,
    "provider":{
      "id":"weekday-hours",
      "rules":[
        {
          "id":"normal-rule",
          "label":"平日早场",
          "priority":0,
          "timeRange":{"start":"10:00","end":"22:00"},
          "pricing":{"unitMinutes":30,"unitPrice":500,"roundGraceMinutes":5,"priceCap":3000}
        }
      ]
    }
  }'
```

## 机器人/店内入口 RPC 接口 (Integration RPC)

Integration RPC 面向聊天机器人、自助入口、扫码入口等可信外部入口。调用方只持有 `integration` API Token，可以通过 QQ、Aime、Telegram 等外部身份直接完成玩家动作；不需要再先调用员工接口拿玩家 ID，也不需要共享 Player Token。

| 请求方法 | 路由路径 | 接口用途 |
| --- | --- | --- |
| `POST` | `/rpc/integration/players/by-identity/resolve` | 按外部身份查找已绑定玩家。 |
| `POST` | `/rpc/integration/players/by-identity/register` | 按外部身份查找或注册玩家，并自动绑定该身份。 |
| `POST` | `/rpc/integration/players/by-identity/session/start` | 按外部身份为玩家开启一条计费 session，可传 `pricingConfigIds` 与 `label`。 |
| `POST` | `/rpc/integration/players/by-identity/checkout/preview` | 按外部身份预览玩家当前 session 结算。 |
| `POST` | `/rpc/integration/players/by-identity/checkout/confirm` | 按外部身份确认玩家当前 session 结算。 |
| `POST` | `/rpc/integration/players/by-identity/sessions/:sessionId/stop` | 按外部身份停止这名玩家名下的单条 session，只结束计时并保留待结算，不立即扣款。授权按玩家归属校验，不区分 session 由哪个渠道开启。 |
| `POST` | `/rpc/integration/players/by-identity/wallet` | 按外部身份读取玩家钱包总览。 |
| `POST` | `/rpc/integration/players/by-identity/assets` | 按外部身份读取玩家资产持有与流水。 |
| `POST` | `/rpc/integration/players/by-identity/history` | 按外部身份读取玩家计时记录。 |
| `POST` | `/rpc/integration/players/by-identity/redeem` | 按外部身份为玩家兑换礼物码。 |
| `POST` | `/rpc/integration/players/by-identity/device-actions` | 按外部身份申请设备动作，例如启机、投币或 Aime 扫卡；后端会先解析玩家并检查 active session、投币冷却等规则。 |
| `GET` | `/rpc/integration/sessions/active` | 机器人列出在场所有活跃 session，含玩家对外身份（QQ 等）以便从聊天平台拉取昵称。 |
| `GET` | `/rpc/integration/device-states` | 机器人列出当前所有设备上报的电源/状态，供 `/show` 一类查询。`deviceStates[].state` 是普通字符串（如 `on`、`off`），不得再包装为 JSON 字符串。 |

Integration body 支持结构化身份和简写身份：

```json
{
  "identity": {
    "provider": "qq",
    "subject": "123456"
  },
  "autoRegister": true,
  "displayName": "QQ 123456"
}
```

也可以写成：

```json
{
  "identityKey": "QQ:123456",
  "autoRegister": true,
  "displayName": "QQ 123456"
}
```

`autoRegister` 为 `false` 或未传时，身份不存在会返回 `PLAYER_IDENTITY_NOT_FOUND` 和 HTTP 404。`autoRegister: true` 会创建玩家并绑定外部身份，然后继续执行这次动作；如果后台配置了 `registration.defaultPresentId`，新玩家会按该礼物当前有效的内容自动获得资产。未配置、已归档、已过期或找不到的默认礼物只会跳过发放，不会阻断注册；后台手动创建玩家也使用同一规则。

机器人或自助入口请求机器动作时，不需要先查玩家 ID。以 QQ 用户触发 maimai 投币为例：

```bash
curl -X POST https://prism.example.com/rpc/integration/players/by-identity/device-actions \
  -H "Authorization: Bearer <integration-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "identity": {"provider":"qq","subject":"123456"},
    "target": {"kind":"game_machine","ref":"舞萌左机"},
    "action": {
      "type": "coin",
      "payload": {"count":1}
    }
  }'
```

成功时返回：

```json
{
  "action": {
    "id": "command-1",
    "type": "coin",
    "status": "pending",
    "target": {"kind":"game_machine","id":"maimai-dx-1"},
    "executorKind": "machine_ws"
  }
}
```

`coin`、`aime.scan`、`power.on` 和 `power.off` 必须对应玩家已有至少一条 active session；没有入场会返回 `DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION`。Integration 的游戏机目标使用 `target.ref`，只接受后端 Hinata IO 配置中的设备 `name` 或 `aliases`，不会把用户输入直接当内部机器 ID。`aime.scan` 的 payload 只需提供 `provider`（默认 `aime`），后端会读取该玩家已绑定的对应身份；没有绑定时返回 `SCAN_IDENTITY_NOT_BOUND_TO_PLAYER`。身份不存在且未显式允许注册时仍返回 `PLAYER_IDENTITY_NOT_FOUND`。受信任集成可为开关机请求附加 `staffOverride: true`，后端会将其记录为员工动作；其他动作使用该字段会返回 `INTEGRATION_STAFF_OVERRIDE_ACTION_NOT_ALLOWED`。

## 机器软件接口 (Machine RPC / WebSocket)

本地 Bun 部署支持机器软件 WebSocket：`GET /rpc/machine/ws`，Header 使用 `Authorization: Bearer <machine-token>`。原生机器软件通过该通道接收投币、刷卡等动作并返回 ACK；后台配置的 Hinata IO 设备则由后端通过加密 relay HTTP 协议直接执行。

机器连接后先发送 hello：

```json
{
  "type": "hello",
  "machineId": "maimai-dx-1",
  "capabilities": ["coin", "aime.scan"]
}
```

服务端会记录机器在线状态、能力列表和最后心跳时间，并回复：

```json
{
  "type": "hello.ack",
  "machineId": "maimai-dx-1",
  "status": "online"
}
```

如果该机器有待执行命令，服务端会立即发送：

```json
{
  "type": "command",
  "commandId": "command-1",
  "action": "coin",
  "payload": {"count":1},
  "expiresAt": "2026-07-07T13:30:00.000Z"
}
```

机器执行成功后回复：

```json
{
  "type": "ack",
  "commandId": "command-1",
  "status": "success"
}
```

执行失败时回复：

```json
{
  "type": "ack",
  "commandId": "command-1",
  "status": "failed",
  "message": "coin controller timeout"
}
```

成功 ACK 会把命令标记为 `acked`；失败 ACK 会把命令标记为 `expired`，并把失败信息写入命令 payload 的 `machineAck` 字段，供员工后台审计。机器可以定期发送 `{"type":"ping"}` 刷新心跳，服务端会回复 `{"type":"pong","machineId":"..."}` 并顺带推送当前可投递命令。

### 店家手动绑定玩家账号

`POST /api/v1/shops/:shopCode/staff/qq-binding/confirm` 接收 `{ code, qq }`，由已登录且拥有该店玩家管理权限的负责人或管理员调用。验证码来自玩家的 QQ 绑定页面，仍按店铺隔离、五分钟有效、单次使用；只读店员和其他店铺成员不可调用。管理员确认可创建新 QQ 档案，不受自助注册开关限制；已有档案、余额和记录直接沿用。账号/QQ 冲突或停用档案仍拒绝绑定。Bot 端点与此入口共用绑定逻辑，Bot 仍遵循店铺自助注册设置。后台入口位于「玩家 → 绑定账号」。
