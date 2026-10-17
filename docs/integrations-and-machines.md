# 外部入口与机器软件接入指南

PRiSM Next 的 API 服务是店铺经营数据的唯一事实源。聊天机器人、自助入场页、扫码入口这类面向玩家的系统统称为 Integration；投币、Aime、门禁、电源、空调等机器侧软件统称为 Machine。两者都通过 Staff Web 生成的接入密钥访问后端，但权限和 API 边界不同。

---

## 1. Integration：机器人与店内入口

Integration 适合 Koishi、AstrBot、自助 Web 入场页、扫码入口等“代表玩家发起业务动作”的系统。它不再需要共享 Player Token，也不需要先调用 Staff API 查询玩家 ID；调用方只需要提交外部身份，后端会负责查找或注册玩家。

**Token 要求：**

- 在 Staff Web「员工与系统」中创建「机器人/店内入口」密钥。
- 请求 Header 使用 `Authorization: Bearer <integration-token>`。
- 不需要 `X-PRiSM-Player-Id`。

### 外部身份

推荐使用结构化身份：

```json
{
  "identity": {
    "provider": "onebot",
    "subject": "123456"
  }
}
```

也可以使用迁移兼容简写：

```json
{
  "identityKey": "onebot:123456"
}
```

`provider` 会统一转成小写，`subject` 只去掉首尾空白。简写只按第一个冒号分隔，所以 `telegram:abc:def` 会解析为 provider `telegram`、subject `abc:def`。

### 常用玩家动作

### 在场客流与设备状态

机器人对自己投资的入口可以读取「在场玩家」和店内设备上报：

| 路由 | 用途 |
| --- | --- |
| `GET /rpc/integration/sessions/active` | 列出在场所有活跃 session，含 `playerDisplayName`、`identities` (provider+subject)、`startedAt`、`label`、`elapsedMinutes`。机器人在 `/list`、`/窝里` 这类命令里用 `identities` 中的 `subject`（平台用户 ID）去调用聊天平台 API 拉昵称，而不是直接显示后台存的 `playerDisplayName`。 |
| `GET /rpc/integration/device-states` | 列出每台已启用、绑定了电源的设备的电源状态，**每次请求实时读取 Home Assistant**（电源可能在平台外被改动）。`state` 为 `on`/`off`；读不到时 `status` 为 `offline`、`state` 为最后一次观测值或 `unknown`。`metadata.aliases` 为设备别名。bot 的 `/show` 与自动关机直接消费。 |

平台昵称的取法因适配器而异：Koishi 走 `session.bot.getUser(qq)`，AstrBot 在 aiocqhttp 走 `bot.call_action("get_stranger_info", user_id=qq)`，telegram、微信、Aime 等按对应适配器提供的方法拉取；取不到则退化为后台存的玩家名。机器人不要把后台存的 displayName 直接写进消息，避免不同身份来源的玩家出现 `Player 123` 这种开发者命名。

### 按外部身份的玩家动作

Integration player actions 都在 `/rpc/integration/players/by-identity/*` 下：

| 路由 | 用途 |
| --- | --- |
| `POST /resolve` | 查找已绑定玩家。 |
| `POST /register` | 查找或注册玩家，并绑定外部身份。 |
| `POST /session/start` | 给玩家开启一条计费 session。 |
| `POST /checkout/preview` | 预览玩家当前 session 结算。 |
| `POST /checkout/confirm` | 确认玩家当前 session 结算。 |
| `POST /sessions/:sessionId/stop` | 停止这名玩家名下的某一条 session，不论它由谁开启。 |
| `POST /wallet` | 查看玩家钱包。 |
| `POST /assets` | 查看玩家资产与流水。 |
| `POST /history` | 查看玩家计时记录。 |
| `POST /redeem` | 为玩家兑换礼物码。 |
| `POST /device-actions` | 按玩家外部身份申请设备动作，例如投币或 Aime 扫卡。 |

示例：平台用户第一次发送 `/入场`，不存在就自动注册，并进入标准音游计费：

```bash
curl -X POST https://prism.example.com/rpc/integration/players/by-identity/session/start \
  -H "Authorization: Bearer <integration-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "identityKey": "onebot:123456",
    "autoRegister": true,
    "displayName": "onebot:123456",
    "pricingConfigIds": ["music-standard"],
    "label": "音游区间",
    "entry": true
  }'
```

Bot 调用应明确区分会话类型：普通入场传 `"entry": true`（服务端按店铺入场规则去重，保存为规范标签 `entry`）；麻将上桌、包间等另开的独立计费会话传 `"entry": false`，并提交自己的 `label` 和 `pricingConfigIds`，即使与入场规则重叠也不会折叠为原入场 session。没有 `entry` 字段的旧客户端只会按空标签、`entry`、`音游区间` 识别为入场；使用自定义入场标签的 Bot 必须升级到显式字段。无论请求里的 `autoRegister` 如何设置，服务端都以店铺是否允许自动注册为准。

机器人或自助入口应该在配置中明确指定普通 `/login`、`/入场` 使用的标准计费方案，并把它作为 `pricingConfigIds` 传给 `/session/start`。不要依赖“空请求体使用后端默认方案”的行为；当店内同时启用了音游、麻将叠加、包间或固定收费方案时，空请求可能会让普通入场错误套用所有启用方案。麻将、包间等附加服务应另开平级 session，并为那条 session 传对应的附加计费方案。

如果 `autoRegister` 为 `false` 或未传，而身份没有绑定玩家，接口会返回 `PLAYER_IDENTITY_NOT_FOUND` 和 HTTP 404。

`POST /sessions/:sessionId/stop` 用于结束某一条 session 的计时但不结账，典型场景是 AstrBot 的麻将叠加计时：一张桌子每人各持一条平级 session，有人下桌只停他自己那一条，其余人继续。它会把 session 关闭并标记为待结算，不会扣款；玩家最终离店时，统一结算会把仍在运行的 session 和已经停止但未结算的 session 一起计算。

授权边界是**玩家**，不是开启渠道：接口校验外部身份对应的玩家与 session 归属，拿一个 Integration Token 停不了别人的 session；但在这名玩家名下，无论 session 是机器人开的、扫码入口开的还是员工在后台开的，都可以停。计费和结账历来不区分开启渠道，停表也一致。session 上的 `metadata.createdBy` 只记录来源供审计，不参与任何鉴权判断。

没有单独的客户端 SDK；集成直接调用 HTTP API。以下示例使用平台原生 `fetch`：

```ts
await fetch("https://prism.example.com/rpc/integration/players/by-identity/session/start", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.PRISM_INTEGRATION_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    identity: { provider: "onebot", subject: "123456" },
    autoRegister: true,
    displayName: "onebot:123456",
    pricingConfigIds: ["music-standard"],
    label: "音游区间",
  }),
});
```

玩家命令需要操作机器或设施时，也继续使用 Integration Token。后端会先按 平台用户 ID解析玩家，再检查该玩家是否已入场、投币冷却是否满足，最后生成发给机器通道或设施执行器的指令：

Aime 扫卡可以走便利方法：

```ts
await client.requestScanByIdentity(
  {
    provider: "onebot",
    subject: "123456",
  },
  {
    deviceRef: "舞萌左机",
    provider: "aime",
  },
);
```

`coin`、`aime.scan`、`power.on` 和 `power.off` 都要求玩家当前至少有一条正在运行的计费 session。未入场时接口返回 `DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION`。Bot 不接收游戏机内部 ID 或 Aime 卡号：游戏机通过后台配置的 `name` / `aliases` 解析，刷卡身份由后端从当前玩家已绑定的 `aime` 身份中读取。Bot 配置为关机仅管理员可用时，只允许白名单管理员提交 `power.off` 请求，并附加 `staffOverride: true`；`power.on` 仍要求玩家已入场。后端将覆盖请求记录为员工动作。该覆盖只接受 `power.on/off`，不能用于投币、刷卡或其他设施动作。

旧的 `botToken + playerToken + staffToken` 普通命令模式已经废弃。Integration Token 可调用受限的管理员快捷操作接口：按外部身份调整玩家资产（`POST /rpc/integration/players/by-identity/assets/adjustments`）和按指定总价立即结账（`POST /rpc/integration/players/by-identity/checkout/override`）。这两个接口不授予完整 Staff API 权限；机器人仍必须在自身配置中限制可发起该操作的平台管理员。麻将上桌、下桌这类玩家业务命令不需要额外权限。

---

## 2. 设备：能力、动作与事件

一台设备（`machines`）只表示身份：名称、别名、二维码 `public_id`、是否启用。它能做什么由绑定的**能力**决定，每个能力是 `device_capabilities` 的一行：

| 能力 | 配置（`config_json`） | 密钥（`secret_json`，每个值单独加密） | 动作 | 设备回报 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `power` | — | `binding`（HA 地址、实体、令牌） | `power.on`、`power.off` | — | `power`，外部权威，实时读取 |
| `hinata_io` | `transport`（`external`/`embedded`）、`coinKey`、`coinAfterSwipe`、`channel` | `url`、`password`（仅外部中继） | `aime.scan`、`coin` | `card.state`、`card.consumed`、`led.set`（不存） | `link`，平台权威 |
| `door` | `lockId` | — | `door.open` | — | — |
| `mahjong` | `capacity`、`pricingConfigIds` | — | —（上下桌走麻将流程） | — | — |

能力目录写在 `packages/server/src/devices/capabilities.ts`，是唯一的定义处：配置校验、动作是否算作「玩过」（计费宽限用）、哪些回报要存、状态由谁权威，都在这里声明。数据库里没有能力名或事件类型的 CHECK 约束，新增能力不需要改表。

### 动作、副作用与事件

- **动作**是平台向设备提出的请求（意图）。每次动作记为一条 `device_operations`，同时写入一条 `request` 事件；执行后写 `result` 事件并结算为 `succeeded`/`failed`。网络超时等**无法确定结果**的情况保持 `pending`：设备可能已经动作了，计费一直把未结算的请求算作使用。
- **副作用**是现实中发生的事（机器开了、卡进了游戏），平台不能直接观察。
- **事件**是平台记录下来的事实（`device_events`，只增不改）：`request`/`result`（平台发起）、`signal`（设备回报，如 `card.consumed`）、`change`（状态变化，如电源从开到关、机台上线/掉线）。
- 设备回报 `card.consumed` 时，会把对应的 `aime.scan` 操作标记为 `confirmed_at`（只认本设备的操作）。
- 状态（`device_state`）只在值变化时写一条 `change` 事件。电源是**外部权威**：每次需要时实时读取 Home Assistant，存储只保留观测历史；直连链路 `link` 是**平台权威**，由中继在连接/断开时写入。
- 以后要做「空闲/忙碌」这类派生状态时，应当监听**事件**（包括设备回报和观测到的变化），而不是只看平台发出的动作。

所有写入都经过 `packages/server/src/devices/bus.ts`：`perform`（动作）、`signal`（回报）、`setOwned`（平台权威状态）、`observe`（实时读外部状态）。其他代码不直接写设备表。卡号只作为临时参数交给执行器，从不落库；门锁临时密码只在本次响应返回。

### 设备看板与编辑器（Web）

商户后台的设备页按「设备是身份、能力是配置」组织，与服务端能力目录一一对应：

- 设备卡片只陈述三件事：设备身份（名称、别名、启用状态）、已绑定的能力徽章、实时状态（电源、直连在线）。卡片底部是「操作」（主按钮）、「编辑」、「操作记录」和二维码入口；有可执行能力的设备才显示「操作」，只读账号不显示。
- **下发操作与历史记录是两个入口**：`操作` 打开只含开机/关机/投币/开门密码的确认面板，`操作记录` 打开只读的事件时间线。两者混在一个弹窗里会让有后果的按钮看起来像记录的一部分。
- 编辑器分两段：**设备身份**（名称、别名、启用）和**设备能力**。每项能力是一张带开关的卡片——电源、刷卡（外部中继或直连）、开门密码、麻将桌；关闭的能力不渲染其表单，避免四种凭据同时铺开。提交按钮吸底，长表单无需滚到末尾才能保存。
- 直连模式（`transport: "embedded"`）的令牌是**显式签发的**：面板里只有「签发设备令牌 / 轮换设备令牌」按钮，普通保存不会顺手创建凭据；未签发就保存会被拒绝并提示先签发或改用外部中继。签发成功后弹窗切换为一次性交付步骤，显示令牌、可复制的两行 INI 片段（`serverUrl=` / `deviceToken=`），在点击「我已写入机台」之前关闭按钮禁用。轮换前明确提示机台现有令牌会立即失效。
- 能力判定集中在前端适配层 `packages/prism-web/src/ui/merchant/device-capabilities.ts`（`deviceCapabilities`、`canOperateCoin`、`deviceActions`、`deviceSummaryKey`）。卡片徽章、操作记录里的可用动作、编辑器里的开关都读这一处，不再各自从 `ttlockLockId`/`homeAssistant`/`hasHinata` 推导。
- 提交仍使用商户 API 的扁平字段（`homeAssistant`、`ttlockLockId`、`mahjong`、`hinataUrl`/`hinataPassword`、`relayConnection`、`coinKey`、`coinAfterSwipe`）；关闭某项能力时发送 `null`（刷卡为 `relayConnection: "external"` + `hinataUrl: null`）让服务端删除对应能力行。适配层只是视图模型，不改变接口契约。

### 「操作」面板

- `GET /api/v1/merchant/machines` 的每台设备带 `actions`：能力目录里当前可用的动作，形如 `{ name: "power.on", capability: "power" }`。后台「操作」面板按 `capability` 分组渲染（电源控制 / 刷卡·HINATA IO / 开门密码 / 麻将桌），**新增能力不需要改前端**；前端只在接口没有 `actions` 时退回本地推导。
- 每个分组标题右侧显示与该组操作相关的状态：电源为实时 `power`（已开机/已关机/未知），直连刷卡为链路在线状态（外部中继则显示连接方式），门锁显示 `lockId`，麻将桌显示 `已入座 / 容量`。
- 麻将上桌的候选人来自 `staff/live-players`（已入场在店玩家），已入座的人不重复出现；上桌要求该玩家有进行中的入场，所以全量玩家列表里大多数人本来就会失败。
- 刷卡由店员直接输入 **20 位卡号**（`cardNumber`）发送；也兼容传 `playerId`，平台读取该玩家绑定的卡号（优先 `aime` provider）。卡号只作为临时参数交给执行器，不落库；卡号格式不合法返回 400，玩家没有绑定卡返回 `SCAN_IDENTITY_NOT_BOUND_TO_PLAYER`。
- `mahjong.seat` / `mahjong.unseat` 接受 `playerId`，让所选玩家上桌/下桌。上桌与玩家自身上桌走同一套校验：玩家必须启用、计费开启时必须有进行中的入场（`CHECKIN_REQUIRED`），麻将计费规则必须齐全且处于可计费时段。店员操作不校验店员自身定位，但玩家资格、封禁与牌桌容量照常校验。
- `GET /api/v1/merchant/machines/:id/state` 返回 `{ power, mahjong }`；`mahjong` 为 `{ capacity, seats: [{ playerId, name, playing }] }`，供操作面板显示座位并选择下桌对象。没有麻将能力的设备返回 `null`。

- 投币可以在操作面板现场指定要按的键（`key`）：字母、数字、空格、Enter、常用未加 Shift 的符号都支持；不传则使用设备配置的 `coinKey`。服务端把字符映射成 Windows Virtual-Key 码，协议本身只传数字键码，带 Shift 的符号（如 `!`）无法表示。只有店员可以指定按键，玩家端仍使用设备配置。

### 引用设备与 Bot 动作

Bot、员工和 integration API 用 `target.ref` 引用设备，匹配设备 ID、`public_id`、名称或任一别名（不区分大小写、去首尾空白）；多台同名返回 `DEVICE_REFERENCE_AMBIGUOUS`。`all` 只用于 `power.on/off`，作用于所有已启用且绑定电源的设备，每台一条操作，共用同一个父操作 ID。玩家发起 `coin`、`aime.scan`、`power.*` 需要处于活跃计费场次；投币受店铺 `venue.operations.coinCooldownMs` 冷却限制。返回体保持旧的 `DeviceCommand` 形状（`status` 为 `acked`/`pending`/`expired`，`executorKind`、`payload.deviceLabel`、`payload.executorFailure`、门锁的 `temporaryPassword`），Bot 与员工视图无需改动。

### 旧版设备注册表

早期部署把 HA、HINATA IO、TTLock 设备存在店铺设置（`devices.homeassistant` + `devices.homeassistant_connection`、`devices.hinata_io`、`devices.ttlock`）。读取设备列表时（设备看板、Bot 动作、设备状态），这些条目会**自动转成正式设备**：固定 ID `legacy:ha|io|lock:<店铺>:<原 id>`，原 id（HA 实体等）加入别名以保持 Bot 指令可用，旧操作记录里以原 id 或名称记录的设备改指向新设备，然后删除注册表（`devices.homeassistant_connection` 与 `devices.ttlock_connection` 保留）。转换需要平台加密密钥，未配置 `URL_ENCRYPTION_KEY` 时保持原样等待下次。原来的 `scripts/import-legacy-devices.ts` 因此删除。

### TTLock

TTLock 账号是店铺级的，保存在 `app_settings` 的 `devices.ttlock_connection`（字段兼容旧 `prism-neo`：`baseUrl`、`clientId`、`clientSecret`、`appAccount`、`appPwd`、`accessToken`、`refreshToken`、`accessTokenExpiresAt`）。设备上绑定 `door` 能力并填写 `lockId`。`door.open` 调用 `/v3/keyboardPwd/add` 创建 8 位随机临时密码，有效期 3 分钟；access token 过期时先用 `refreshToken`，失败后用账号密码重新获取，并把新 token 写回设置。

### HINATA IO：外部中继

`transport: "external"` 时平台通过 HTTP 访问外部 relay（`secret.url`）。有连接密码时按 Hinata IO 协议用 PBKDF2-HMAC-SHA256 与 AES-256-GCM 生成 `E2EE_V1`：投币向 `<url>/event` 发送有效期 30 秒、带去重 ID 的 `KEY_PRESS`；刷卡向 `<url>` 发送一次性 `SET_CARD`。投币必须有密码，按键码 1–65535。relay 的 HTTP 拒绝记为失败（状态码写入结果事件和登录审计），无响应记为结果未知。外部 relay 的「已接收」不等于机台真正读到了卡。

### HINATA IO：机台直连（内嵌中继）

`transport: "embedded"` 时机台直接连本平台：`[aimeio] serverUrl=<APP_ORIGIN>/io/ws`，再填写平台签发的 `deviceToken`。

- 保存时生成 `prism_io_` 前缀的随机令牌，**只在保存响应里返回一次**，库里只存 SHA-256（`device_capabilities.credential_hash`）。`rotateRelayToken: true` 轮换令牌；通道名 `config.channel` 与令牌无关，轮换不会断开在线机台。
- WebSocket 升级请求带 `Authorization: Bearer <deviceToken>`，平台在握手前按令牌找到设备和通道；令牌无效返回 401，机台客户端把 401/403 当作永久失败停止重连。
- 直连不做端到端加密：平台既是中继也是控制端，卡号本来就由平台从 `cards.access_code` 取出，身份由设备令牌承担，机密性由 `wss://` 承担。保存为直连时会丢弃之前给外部中继存的密码；请求里同时提交密码返回 `DEVICE_RELAY_PASSWORD_CONFLICT`。机台若仍设置了 `remotePassword`，会在 `CLIENT_HELLO` 里声明 `e2ee: true`，平台拒绝下发并在设备看板提示清空。
- 通道是 `MachineRelay` Durable Object（binding `MACHINE_RELAY`，迁移 tag `machine-relay-v1`）。控制端接口不对外暴露，`/io/ws` 是唯一公开路径。设备看板上的「已连接」直接问 Durable Object，不读存储：部署重启会断开连接却不触发断开回调。
- 机台通过同一连接回报 `event.cardStateChanged`、`event.cardConsumed`、`event.ledSet`，分别记为 `card.state`、`card.consumed` 信号；`led.set` 每帧都有，不存储。下发刷卡时平台把操作 ID 放进 `source`，机台原样回传；只有 UUID 形式的 `source` 被当作关联，`Remote`、`HINATA(<实例>)` 等机台本地来源不关联任何操作。

### 设备日志

`GET /api/v1/merchant/machines/:id/events?limit=50`（1–200）按时间倒序返回该设备的事件：

```json
{ "events": [
  { "id": "...", "capability": "hinata_io", "kind": "signal", "name": "card.consumed", "origin": "device",
    "operationId": "6f1c…", "parentOperationId": null, "at": "2026-10-17T10:00:02.000Z",
    "payload": { "card": { "source": "6f1c…" } } },
  { "id": "...", "capability": "hinata_io", "kind": "result", "name": "aime.scan", "origin": "platform",
    "operationId": "6f1c…", "parentOperationId": null, "at": "2026-10-17T10:00:00.400Z", "payload": { "outcome": "ok" } },
  { "id": "...", "capability": "hinata_io", "kind": "request", "name": "aime.scan", "origin": "platform",
    "operationId": "6f1c…", "parentOperationId": null, "at": "2026-10-17T10:00:00.000Z", "payload": { "cardId": "card-1" } }
] }
```

`origin` 为 `platform`（平台发起）、`device`（设备回报）或 `observer`（平台读外部状态时发现变化）。看板把同一操作的 `request` 与 `result` 合并成一行。

**由事件触发操作目前只预留、未实现。** 投币要先抢冷却锁、刷卡要先确定玩家，在确定哪些动作能安全自动执行之前，事件只被记录和读取。

### 旧接口

`/rpc/machine/ws`（原生机器软件 WebSocket 与 `machine_ws` 执行器，只有本地 Bun 服务端提供过，Worker 部署从未开放）已移除；机台改用 `/io/ws` 直连。`GET /rpc/staff/machine-connections` 保留，内容改为直连机台的 `link` 状态。`/api/v1/merchant/device-bindings` 保留但总是返回空列表（注册表已自动转为设备）。旧的 `device_commands`、`device_states`、`machine_connections` 表与 `machines` 上的能力列由迁移 0037 复制到新表后不再写入，保留一个版本以便回滚。

Cloudflare Workers 运行时通过保持原生 `fetch` 调用上下文的包装函数访问 Home Assistant，避免把运行时函数作为普通对象方法调用而触发 `Illegal invocation`。

### 余额不足提示

Web 与 Swift（主 App / App Clip 共用 API 层）按 `INSUFFICIENT_BALANCE` 错误码显示本地化提示：中文“余额不足，请充值后重试”，英文“Insufficient balance. Please top up and try again.”。内部诊断文本变化不影响提示；HTTP 状态与错误码保留，余额不足不视为会话失效。结账被拒绝后保留当前账单和计费状态，不自动重发结账；充值后可手动重试，并使用新的操作 ID。
