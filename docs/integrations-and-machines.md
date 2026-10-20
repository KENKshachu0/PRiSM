# 外部入口与机器软件接入指南

PRiSM Next 的 API 服务是店铺经营数据的唯一事实源。聊天机器人、自助入场页、扫码入口这类面向玩家的系统统称为 Integration；投币、Aime、门禁、电源、空调等机器侧软件统称为 Machine。两者都通过 Staff Web 生成的接入密钥访问后端，但权限和 API 边界不同。

---

## 1. Integration：机器人与店内入口

Integration 适合 Koishi、AstrBot、自助 Web 入场页、扫码入口等“代表玩家发起业务动作”的系统。它不再需要共享 Player Token，也不需要先调用 Staff API 查询玩家 ID；调用方只需要提交外部身份，后端会负责查找或注册玩家。

**为什么要绑定 Bot 身份。** 绑定让店家知道每位玩家在该平台的身份（例如 QQ 号），玩家有迹可循；在 Koishi 里把绑定命令限制在店铺群内，就只有入群的玩家能完成绑定、进店。

**Bot 向玩家开放哪些命令，在 Bot 端配置。** Koishi 插件的 `playerCommands` 默认 `all`；设为 `readonly` 后，玩家只能绑定（`bind`）、查询（余额、账单、记录、资产、查人、设备状态）和兑换（`redeem`），入场、结账、上下桌和设备操作只有 `staffUserIds` 中的管理员能用（包括替其他玩家操作），玩家会收到 `readOnlyNotice`。后台不做这层限制，因为它分不清请求来自管理员还是玩家。

绑定确认不要求店铺启用计费。同一页面可编辑玩家看到的**绑定提示**（`settings.botContact`，含 `{code}` 的一行显示为可复制命令，并有实时预览），用来写明去哪个群、发什么命令，取代固定的「向店铺 Bot 发送 bind 绑定码」（插件命令为 `bind`，旧的 `prism.bind` 保留为同义命令）。Bot 请求里的 `autoRegister` 一律被店铺设置覆盖。

**Token 要求：**

- 在「设置 → Bot 与接入」中创建 Bot 接入凭据。
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

### Bot 的 WebSocket 连接

Koishi 插件（0.2 起）只用一条 WebSocket 和平台通信，不再发 HTTP 请求；HTTP 接口原样保留给旧插件和其它集成。

- 连接：`GET /api/v1/shops/:shop/integration/ws`，`Authorization: Bearer <Bot 凭据>`，WebSocket 升级。凭据在握手前校验，不对返回 403；不要求店铺启用计费（每个请求仍按自己的路由校验）。连接交给店铺 Hub（`ShopHub`），连进来的 WebSocket 可以休眠。
- 请求：`{"type":"request","id":"<唯一 ID>","method":"GET|POST|PUT","path":"integration/players/by-identity/wallet","query":{},"body":{}}`；回复 `{"type":"response","id":…,"status":200,"body":{"data":…}}`，`body` 与 HTTP 响应完全相同（含 `{error:{code,message}}`）。Hub 带着 Bot 凭据在进程内调用同一套路由，所以鉴权、校验、灵动岛推送（`waitUntil`）都和 HTTP 一样；吊销凭据后下一个请求就会 403，Hub 随即以 4003 关闭连接。只能访问本店的 `integration/…` 和 `version`，其它路径（包括 `..`）返回 404。
- 去重：写请求（POST/PUT）的回复按 `id` 保存 10 分钟；同一 `id` 再发一次直接返回保存的回复，不会重复执行；还在执行中的同一 `id` 不再执行。断线后插件不重发、不排队，命令直接失败（「暂时连不上服务器」），避免结账、加钱被重复执行或延后执行。
- 心跳：发送文本 `ping`，回复 `pong`（Workers 上由运行时自动回复，不唤醒 Hub）。
- `{"type":"hello","reminderLeadSeconds":300}`：插件告诉 Hub 闲置关机前多久提醒。之后 Hub 推送 `{"type":"event","event":"idle.reminder","data":{"reason":"shop_empty"|"device_idle","at":<关机时间 ms>,"devices":[{"id","name"}]}}`；Koishi 发到店员配置的群或私聊。多个 Bot 连接时取最长的提前量。

### 常用玩家动作

### 在场客流与设备状态

机器人对自己投资的入口可以读取「在场玩家」和店内设备上报：

| 路由 | 用途 |
| --- | --- |
| `GET /rpc/integration/sessions/active` | 列出在场所有活跃 session，含 `playerDisplayName`、`identities` (provider+subject)、`startedAt`、`label`、`elapsedMinutes`。机器人在 `/list`、`/窝里` 这类命令里用 `identities` 中的 `subject`（平台用户 ID）去调用聊天平台 API 拉昵称，而不是直接显示后台存的 `playerDisplayName`。 |
| `GET /rpc/integration/device-states` | 列出每台已启用、绑定了电源的设备的电源状态，**每次请求实时读取 Home Assistant**（电源可能在平台外被改动）。`state` 为 `on`/`off`；读不到时 `status` 为 `offline`、`state` 为最后一次观测值或 `unknown`。`metadata.aliases` 为设备别名。bot 的 `/show` 直接消费。（插件原来的无人自动关机 `powerOffInterval` 已删除，改为后台的「闲置自动关机」。） |

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
| `power` | `connectionId`、`entityId`（`switch.*`/`input_boolean.*`） | —（旧绑定：`binding`，见下文「店铺 Home Assistant 连接」） | `power.on`、`power.off` | — | `power`，外部权威，实时读取 |
| `climate` | `connectionId`、`entityId`（`climate.*`） | —（同上） | `climate.on`、`climate.off`、`climate.set_mode`、`climate.set_temperature`、`climate.set_fan_mode` | — | `climate`，外部权威，实时读取 |
| `hinata_io` | `transport`（`external`/`embedded`）、`coinKey`、`coinAfterSwipe`、`channel` | `url`、`password`（仅外部中继） | `aime.scan`、`coin` | `card.state`、`card.consumed`、`card.login`（由读卡器灯光推出）、`led.set`（不存） | `link`，平台权威 |
| `door` | `lockId` | — | `door.open` | — | — |
| `mahjong` | `capacity`、`pricingConfigIds` | — | —（上下桌走麻将流程） | — | — |

**空调（`climate`）单列一个能力，不并入电源**：它的状态是模式和温度而不是开/关；用空调不算「玩过」机台（所有空调动作 `countsAsPlay: false`，不会取消入场的免费宽限）；空调关着也不应该挡住机台投币、刷卡（那只看 `power`）。一台设备可以同时带电源和空调（例如包间：灯电源 + 空调）。

- 动作对应 Home Assistant 的 `climate/turn_on`、`turn_off`、`set_hvac_mode`（`mode`）、`set_temperature`（`temperature`）、`set_fan_mode`（`fanMode`）。可选的模式、风速、温度范围和步长不写死，每次从实体的 `hvac_modes`、`fan_modes`、`min_temp`、`max_temp`、`target_temp_step` 读取；实体不接受的值由 Home Assistant 拒绝，操作记为失败。
- 状态读取：`GET /api/v1/merchant/machines/:id/state` 与玩家页 `GET /api/v1/devices/session/state` 都返回 `climate`（`{ mode, modes, temperature, currentTemperature, minTemperature, maxTemperature, temperatureStep, fanMode, fanModes }`，读不到为 `null`）。只把**设定**（模式、目标温度、风速）记为 `change` 事件；室温会自己漂移，记下来每次读取都会多一条。
- 玩家扫码后能做全部空调操作（含关空调）；计费店铺要求先入场，和其它设备动作一样。`power.off` 仍然仅限店员。开启位置校验后，每个空调动作都和机台操作一样要求在店内（`checkShopLocation(…, "machine")`），后台店员操作不校验。
- 玩家页是独立的空调卡片（`PlayerClimate`）：关着时只有「开空调」；开着时中间是大号设定温度和 −/+，下面是带图标的模式分段和风速分段，卡片颜色随模式变化（制冷蓝、制热橙等）。选择立即显示，Home Assistant 回报后以实际状态为准，6 秒内未回报则回到实际状态；连续按 −/+ 会在停下 0.7 秒后合并成一次 `climate.set_temperature`，避免每一步都重新定位、都调用一次 Home Assistant。后台操作面板沿用同一套逻辑，样式更紧凑。
- **「全部开/关机」（`target.ref: "all"` 的 `power.on/off`）同时开/关所有空调**，每台空调记一条 `climate.on/off` 操作，与电源操作共用一个父操作 ID。Bot 的 `off all` 与 Koishi 的无人自动关机都走这条路径，因此也会关空调。
- 保存设备时 `climate` 与电源的 `homeAssistant` 形状相同（见下一节），实体必须是 `climate.*`。

### 店铺 Home Assistant 连接

Home Assistant 的地址和令牌是**店铺级**的：一个 Home Assistant 一条连接，店里所有电源和空调能力都指向其中一条，能力里只存 `connectionId` 和 `entityId`。换令牌或地址只改一处。

- 每条连接是一行 `app_settings`，键为 `devices.ha_connection:<id>`，值为 `{ id, url, internalUrl, token, readToken, readUserId, readAccess, readError, updatedAt }`。`token`（控制用）和 `readToken`（只读）用平台密钥加密；店铺备份下载时解密、导入时用目标环境密钥重新加密，和设备能力的密钥一样。
- 保存设备时 `homeAssistant` / `climate` 二选一：`{ connectionId, entityId }` 直接选连接；或沿用旧形状 `{ url, entityId, token? }`，平台按地址找到或新建连接。令牌留空时依次沿用：这个能力原来的令牌、同一地址的另一个 HA 能力的令牌、店里这个地址已有的连接；都没有返回 `HOME_ASSISTANT_TOKEN_REQUIRED`。同一地址、不同令牌会成为两条连接。
- 旧绑定（url、令牌、实体都在能力密钥 `binding` 里）照常工作，在下次读取店铺设备列表时**自动迁到连接上**：按「地址 + 令牌」生成固定的连接 ID，只在能力行未被改动时改写，所以重复执行或并发执行结果相同；备份正在导出、店铺只读时迁移失败，下次再试。
- 后台接口（店长、管理员；令牌永不返回）：`GET /api/v1/merchant/ha-connections?shopId=` 列出连接与使用它的能力数；`PATCH /ha-connections/:id?shopId=` 改 `url` / `token`；`DELETE` 仅限无设备使用（否则 `HA_CONNECTION_IN_USE`）；`GET /ha-connections/:id/entities?shopId=` 实时读取 HA 的 `switch`、`input_boolean`、`climate` 实体，供设备编辑器选择。

#### 只读账号（实时状态用）

店里负责盯 Home Assistant 的游戏机拿到的令牌**不能开关任何东西**。Home Assistant 没有按实体的权限，但内置用户组 `system-read-only` 只能读、不能控制（调用实体服务时检查控制权限，没有就拒绝）。

- 新建连接后，平台在后台（`waitUntil`）用连接的控制令牌执行：`auth/current_user` 确认是管理员 → `config/auth/create`（`group_ids: ["system-read-only"]`）建用户 → `config/auth_provider/homeassistant/create` 给它随机用户名和密码 → 走 HA 登录流程（`/auth/login_flow` + `/auth/token`，`client_id` 为平台地址）以该用户登录 → 以该用户身份 `auth/long_lived_access_token`（3650 天）→ `config/auth_provider/homeassistant/delete` 删掉它的密码，长期令牌成为这个账号唯一的入口。顺带读 `GET /api/config` 的 `internal_url` 存为 `internalUrl`，供店内机台优先使用。重做时先删除旧的只读用户。
- 控制令牌不是管理员的，`readAccess` 为 `needs_admin`：设备编辑器提示贴一次管理员令牌，`POST /ha-connections/:id/read-access?shopId=`（`{ adminToken? }`）只在这一次请求里使用它，不保存。其它失败记为 `failed` 并带原因，可以重试。本地 Bun 服务端没有 `waitUntil`，只能用这个接口手动触发。
- 依赖 Home Assistant 默认的用户名密码登录方式；店家关掉它时这一步失败，需要手动提供令牌。只读用户仍可调用少数不针对实体的服务（如发通知），但控制不了任何设备。以上只用模拟的 HA 响应测过，未接真实 Home Assistant 验证。

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

- 设备卡片只陈述三件事：设备身份（名称、别名、启用状态）、已绑定的能力徽章、实时状态（电源、空调模式与温度、直连在线）。卡片底部是「操作」（主按钮）、「编辑」、「操作记录」和二维码入口；有可执行能力的设备才显示「操作」，只读账号不显示。
- **下发操作与历史记录是两个入口**：`操作` 打开只含开机/关机/投币/开门密码的确认面板，`操作记录` 打开只读的事件时间线。两者混在一个弹窗里会让有后果的按钮看起来像记录的一部分。
- 编辑器分两段：**设备身份**（名称、别名、启用）和**设备能力**。每项能力是一张带开关的卡片——电源、空调、刷卡（外部中继或直连）、开门密码、麻将桌；关闭的能力不渲染其表单，避免四种凭据同时铺开。提交按钮吸底，长表单无需滚到末尾才能保存。
- 直连模式（`transport: "embedded"`）的令牌是**显式签发的**：面板里只有「签发设备令牌 / 轮换设备令牌」按钮，普通保存不会顺手创建凭据；未签发就保存会被拒绝并提示先签发或改用外部中继。签发成功后弹窗切换为一次性交付步骤，显示令牌、可复制的两行 INI 片段（`serverUrl=` / `deviceToken=`），在点击「我已写入机台」之前关闭按钮禁用。轮换前明确提示机台现有令牌会立即失效。
- 空设备页说明「设备」对应店里一样玩家扫码就能用的东西；`/merchant/:shop/devices?add=1` 直接打开添加设备弹窗（开店指引使用）。二维码弹窗提供「打印」（新窗口只含二维码和设备名）、带「已复制」反馈的复制链接和测试扫码入口。NFC 入口就是把同一个链接写进标签的 NDEF URI 记录：iPhone 碰一下会唤起 hinata_go 里的 PRiSM Link App Clip（免安装），其它手机用浏览器或 HINATA Go 打开；弹窗下方写明了这一点。
- 编辑器里开门密码能力会检查店铺 TTLock 账号：未连接时红字提示并链接到「设置 → 位置与设备」；麻将桌没有可选计费规则时链接到「计费」页（未启用计费时链接到转换向导）；外部中继缺连接密码时说明投币为何不可设置。
- 能力判定集中在前端适配层 `packages/prism-web/src/ui/merchant/device-capabilities.ts`（`deviceCapabilities`、`canOperateCoin`、`deviceActions`、`deviceSummaryKey`）。卡片徽章、操作记录里的可用动作、编辑器里的开关都读这一处，不再各自从 `ttlockLockId`/`homeAssistant`/`hasHinata` 推导。
- 提交仍使用商户 API 的扁平字段（`homeAssistant`、`ttlockLockId`、`mahjong`、`hinataUrl`/`hinataPassword`、`relayConnection`、`coinKey`、`coinAfterSwipe`）；关闭某项能力时发送 `null`（刷卡为 `relayConnection: "external"` + `hinataUrl: null`）让服务端删除对应能力行。适配层只是视图模型，不改变接口契约。

### 「操作」面板

- `GET /api/v1/merchant/machines` 的每台设备带 `actions`：能力目录里当前可用的动作，形如 `{ name: "power.on", capability: "power" }`。后台「操作」面板按 `capability` 分组渲染（电源控制 / 刷卡·HINATA IO / 开门密码 / 麻将桌），**新增能力不需要改前端**；前端只在接口没有 `actions` 时退回本地推导。
- 空调分组（`ClimateControls`，与玩家扫码页共用）：开/关空调，以及按实体上报的模式、温度加减（按步长、限制在最低/最高温度之间）和风速，单击即下发；标题右侧显示「模式 · 设定温度 · 室温」。
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
- 机台断线重连时，平台只重发**仍在有效期内、且还没被游戏取走**的那张卡（客户端默认 3 秒后丢弃远程卡）。游戏取走后（`source` 一致的 `card.consumed`）或过了有效期，存着的卡就被删除；旧版本存下的、没有有效期的卡一律不重发。否则机台几小时后重启，会把上一位玩家的卡再塞进游戏。

#### 扫码刷卡的结果

玩家在扫码页刷卡（`POST /api/v1/machines/login`）时，直连机台会等到游戏给出结果再返回：

1. 发卡前先在 `MachineRelay` 内存里登记等待，再下发 `SET_CARD`；等待期间请求未返回，对象不会休眠。
2. 约 4.5 秒内收到 `source` 一致的 `event.cardConsumed`，记下是哪个读卡器（`unit_no`）取走的；收不到就是 `not_read`（游戏不在读卡，卡已作废）。
3. 之后约 15 秒内，**同一个读卡器**的 `event.ledSet` 变成 `0000FF` 记为登录成功（`ok`），变成 `FF0000` 或 `FFFF00` 记为被拒（`failed`），并存一条 `card.login` 信号（`payload.result`）。等不到这三种颜色就是 `read`：游戏拿到了卡，但没有给出结论。
4. 新卡会顶掉机台上还没被取走的旧卡，旧卡的等待随即以 `not_read` 结束。

响应新增 `card` 字段：`ok`、`failed`、`read`、`not_read`；外部中继收不到任何回报，记为 `sent`。旧客户端忽略这个字段。开启「刷卡后自动投币」时，`not_read` 和 `failed` 不投币，`coin` 返回 `skipped`，`reason` 分别为 `CARD_NOT_READ`、`LOGIN_FAILED`。扫码页在卡片行的说明文字里显示「登录成功」「登录失败」（`failed` 和 `not_read` 都显示这个）「已刷卡」，投币结果接在后面（如「登录成功 · 投币失败」）；结果停留几秒，期间其它卡片和投币按钮照常可用。`card.consumed` 只说明游戏从读卡接口拿到了卡号，灯光颜色才反映游戏服务器的结论。

### 店铺 Hub：谁替店里盯着 Home Assistant

平台不再每次都去问 Home Assistant。每家店有一个 `ShopHub` Durable Object（binding `SHOP_HUB`，迁移 tag `shop-hub-v1`，名字是店铺 ID），它从店里**在线的直连 HINATA IO 中挑一台**，让它在局域网里用只读令牌订阅 Home Assistant（`subscribe_entities`），把状态变化经已有的设备连接报回来。HA 不必暴露到公网，平台这边也没有长连接：机台连进来的 WebSocket 照常可以休眠。

- **谁能被选**：`CLIENT_HELLO` 的 `body.features` 含 `ha.watch` 的机台。`MachineRelay` 收到这样的 hello 就告诉 Hub 自己上线（`relayOnline`），最后一个这样的连接断开时告诉 Hub 下线（`relayOffline`）。网关把通道名放在 `x-prism-relay-channel` 头里交给 `MachineRelay`，Hub 用它回头找到这台机台。
- **选谁**：在线最久的那台；刚失败过的（连不上 HA、没能下发、租约过期）5 分钟内排在后面。同一时间只有一台在订阅，令牌只在它的内存里。
- **下发**：`{"action":"HA_WATCH","body":{"term":3,"connections":[{"id":"ha_…","urls":["http://ha.local:8123","https://ha.example"],"token":"<只读令牌>","entities":["switch.a","climate.b"]}]}}`。`urls` 按顺序尝试，店内地址（HA 的 `internal_url`）在前。换人时给原来那台发 `{"action":"HA_UNWATCH","body":{}}`。只有已经签好只读账号、且有设备用到的连接会下发；一条都没有就不选人。
- **上报**（JSON-RPC 通知，无 `id`）：`ha.status {term, connection, connected, error?}`，订阅建立或断开时、以及每 30 秒一次作为心跳；`ha.states {term, connection, full, states:[{entity_id, state, last_changed, attributes}]}`，第一次是全量，之后只报变化；`last_changed` 是 HA 压缩状态里的 Unix 秒（也接受 ISO 文本），`attributes` 只带平台用到的空调属性。任何上报都给租约续期 90 秒；`term` 不是当前任期、或不是当前那台发的，一律丢弃，所以交接时两台短暂同时上报也无害。`connected: false` 且店里还有别的候选时立即换人。
- **换人**：那台下线时立即改派；90 秒没有任何上报，Hub 的 alarm 把它排到后面并改派。新那台订阅后先报全量，期间漏掉的变化自动补齐。设备、连接或只读账号变化后，后台接口让 Hub 重新下发（`refresh`）。
- **记录**：上报的状态存在 Hub 里；有设备用到的实体，电源的开关变化、空调的设定变化（模式、目标温度、风速）通过设备总线的 `report` 写入 `device_state` 并记 `change` 事件，**时间用 HA 的 `last_changed`**，所以在米家或物理按钮开机，也能知道真正的开机时间。
- **扫码页实时推送**：`GET /api/v1/devices/session/ws?ticket=`（玩家登录态 + 设备二维码会话，WebSocket 升级）连到店铺 Hub。连上先收到 `{"type":"hello","watching":true|false,"power"?,"climate"?}`；之后这台设备的电源变化推 `{"type":"state","power":"on"|"off"}`，空调变化（含室温）推 `{"type":"state","climate":{…同 /session/state 的 climate}}`；有没有机台在盯 HA 变化时推 `{"type":"watching","watching":…}`。网页在有人盯着且已收到电源状态时停掉电源轮询，否则照旧轮询；`/session/state` 和 `/session/power` 两个轮询接口保留，旧版 App Clip 继续使用。
- **读取**：电源读取先问 Hub。有人在盯、缓存是「开」就直接用；缓存是「关」或没人在盯，照旧现场问 HA——把玩家挡在一台其实开着的机器外面代价更大。空调状态有缓存就直接用。平台刚发出开关机或空调命令后的那一次读取（`observeAfter` 和操作响应）一律现场读，因为 Hub 可能还没收到变化。

### 闲置自动关机

两条规则，**默认都关**，由店长在「设置 → 位置与设备 → 闲置自动关机」打开（`GET/PUT /api/v1/merchant/idle-power?shopId=`，存在 `app_settings` 的 `devices.idle_power`）：

- **店里没人**：没有任何进行中的场次满 N 分钟（默认 15），关掉所有开着的电源和所有在运行的空调。一段「没人」只执行一次；没人的起点取 Hub 记下的时间，没有就取最后一次结账时间。
- **单台设备闲置**：设备开着、超过闲置时长没有活动。默认时长为 0（不启用）；每台设备可以单独设置时长，或设为「从不自动关机」（`PUT /idle-power/devices/:deviceId?shopId=`，`{ minutes: number|null, exclude }`，`null` 用店铺默认，`0` 不参与）。店里没人且「店里没人」规则关着时直接关机；店里有人时按店长的选择：只标记为闲置、通过 Bot 提醒、或直接关机——平台不知道谁在玩哪台，游客模式、实体投币都没有任何回报。

**活动**指能说明有人在用这台设备的事：机台的 `card.state`、`card.consumed`、`card.login` 信号，以及玩家或店员发起的、算作「玩过」的动作（`power.on`、`coin`、`aime.scan`、`power.keep`；关机不算）。设备开机的时刻也算一次，所以在 HA 外面手动开机也有完整的闲置时长（有 Hub 盯着时用 HA 的 `last_changed`）。

**执行**由店铺 Hub 负责：只记最后活动时间，不逐秒倒数；alarm 设在最早的截止时间。刷卡信号、扫码操作、刷卡登录、店铺接口的任何写操作（入场、结账等）和设置保存都会「碰一下」Hub，2 秒内的多次合并成一次检查。检查时从 D1 读设置、进行中的场次、电源与空调状态（优先用 Hub 盯到的状态）和最近 24 小时的活动，交给 `planIdle` 决定，然后以**系统身份**（`{type:"system"}`）执行 `power.off` / `climate.off`——不算任何人的活动，也不刷新自己的倒计时。自动关机失败的设备 10 分钟内不再重试。闲置标记是电源能力的平台状态 `idle`（`true`/`false`），变化记 `change` 事件，设备日志显示「已闲置 / 恢复使用」。

**延迟关机**：`power.keep`（电源能力的动作，要求已入场、算作「玩过」）。它不调用 HA，设备开着才成功，关着返回「设备已关机」，所以延迟永远不会把设备开起来。玩家在扫码页点「开机」效果相同。

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
