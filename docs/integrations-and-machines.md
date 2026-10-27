# 外部入口与机器软件接入指南

PRiSM Next 的 API 服务是店铺经营数据的唯一事实源。聊天机器人、自助入场页、扫码入口这类面向玩家的系统统称为 Integration；投币、Aime、门禁、电源、空调等机器侧软件统称为 Machine。两者都通过 Staff Web 生成的接入密钥访问后端，但权限和 API 边界不同。

---

## 1. Integration：机器人与店内入口

Integration 适合 Koishi、AstrBot、自助 Web 入场页、扫码入口等“代表玩家发起业务动作”的系统。它不再需要共享 Player Token，也不需要先调用 Staff API 查询玩家 ID；调用方只需要提交外部身份，后端会负责查找或注册玩家。

**为什么要绑定 Bot 身份。** 绑定让店家知道每位玩家在该平台的身份（例如 QQ 号），玩家有迹可循；在 Koishi 里把绑定命令限制在店铺群内，就只有入群的玩家能完成绑定、进店。

**Bot 向玩家开放哪些命令，在 Bot 端配置。** Koishi 插件的 `playerCommands` 默认 `all`；设为 `readonly` 后，玩家只能绑定（`bind`）、查询（余额、账单、记录、资产、查人、设备状态）和兑换（`redeem`），入场、结账、上下桌和设备操作只有 `staffUserIds` 中的管理员能用（包括替其他玩家操作），玩家会收到 `readOnlyNotice`。后台不做这层限制，因为它分不清请求来自管理员还是玩家。

绑定确认不要求店铺启用计费。「设置 → 玩家与身份 → 绑定提示」可编辑玩家看到的**绑定提示**（`settings.botContact`，含 `{code}` 的一行显示为可复制命令，并有实时预览），用来写明去哪个群、发什么命令，取代固定的「向店铺 Bot 发送 bind 绑定码」（插件命令为 `bind`，旧的 `prism.bind` 保留为同义命令）。Bot 请求里的 `autoRegister` 一律被店铺设置覆盖。

**Token 要求：**

- 在「资源」页添加一个带「店铺 Bot」能力的资源，保存时签发 Bot 接入凭据（只显示一次，连同 API 地址；凭据自己指明店铺，界面上不再显示店铺编号）。「店铺 Bot」一项里显示凭据是否已签发，按钮与 HINATA IO 直连的「签发/轮换设备令牌」同一套：签发或轮换只换凭据，不新建 Bot 资源，旧凭据立即失效。设置里不再有「Bot 与接入」分组。
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

- 连接：`GET /integration/ws`，一个固定路径，和机台的 `/io/ws` 一样：`Authorization: Bearer <Bot 凭据>`，凭据在握手前解析出店铺，地址里不出现店铺编号或 Bot 标识。凭据不对返回 403，请求不会到店铺的 Hub；不要求店铺启用计费（每个请求仍按自己的路由校验）。旧地址 `/api/v1/shops/:shop/integration/ws` 仍可连接。连接交给店铺 Hub（`ShopHub`），连进来的 WebSocket 可以休眠。
- 设备动作失败时，Bot 只告诉玩家关于设备本身、他能理解的事：没有这个设备、设备未连接、设备已关机、设备没有响应。其余原因（配置、通信细节、TTLock 错误码等）只写日志，回复「操作没有完成，请找店员」。超时（请求发出去但没等到应答）按「设备没有响应」处理，不再只有「请稍后再试」。`action.status` 为 `pending`（未确认）时也带 `payload.executorFailure.message`，但仅供 Bot 判断，不直接展示。
- 请求：`{"type":"request","id":"<唯一 ID>","method":"GET|POST|PUT","path":"integration/players/by-identity/wallet","query":{},"body":{}}`；回复 `{"type":"response","id":…,"status":200,"body":{"data":…}}`，`body` 与 HTTP 响应完全相同（含 `{error:{code,message}}`）。Hub 带着 Bot 凭据在进程内调用同一套路由，所以鉴权、校验、灵动岛推送（`waitUntil`）都和 HTTP 一样；吊销凭据后下一个请求就会 403，Hub 随即以 4003 关闭连接。只能访问本店的 `integration/…` 和 `version`，其它路径（包括 `..`）返回 404。
- 去重：写请求（POST/PUT）的回复按 `id` 保存 10 分钟；同一 `id` 再发一次直接返回保存的回复，不会重复执行；还在执行中的同一 `id` 不再执行。断线后插件不重发、不排队，命令直接失败（「暂时连不上服务器」），避免结账、加钱被重复执行或延后执行。
- 心跳：发送文本 `ping`，回复 `pong`（Workers 上由运行时自动回复，不唤醒 Hub）。
- `{"type":"hello","reminderLeadSeconds":300}`：插件告诉 Hub 闲置关机前多久提醒。之后 Hub 推送 `{"type":"event","event":"idle.reminder","data":{"reason":"shop_empty"|"device_idle","at":<关机时间 ms>,"devices":[{"id","name"}]}}`；Koishi 发到店员配置的群或私聊。多个 Bot 连接时取最长的提前量。

### Bot 是一种资源：设置由服务端下发

每个机器人对应一个带 `bot` 能力的资源，在商户工作台「资源」页添加和编辑（见[资源与资源组](resources.md)）。添加时签发它的接入凭据（只显示一次），删除资源、关闭 Bot 能力或「重新签发」都会吊销旧凭据，旧连接随之断开。凭据与 Bot 资源一一对应：新建店铺时勾选「创建 Bot 接入凭据」会同时建好它的 Bot 资源（默认资源组）；迁移会把旧版遗留的接入凭据一并迁成 Bot 资源（`0043_legacy_bot_resources.sql`），正在运行的 Bot 不会因此断线。Bot 资源不能被玩家扫码。

插件本地只需要 API 地址和接入凭据：凭据自己指明店铺，插件直接连 `/integration/ws`，连上后从 `integration/bot` 读到店铺编号，用于构造网页链接。旧配置里的店铺编号仍被接受，但不再需要。其余都由 `GET integration/bot` 下发：

| 字段 | 来源 |
| --- | --- |
| `bot` | 资源 ID 与名称（名称也用于 Home Assistant 监听名单） |
| `settings` | 在 Bot 资源上设置：玩家命令全部/只读及提示、店员命令、关机仅限店员、结账回执发给店员、闲置提醒的群与提前分钟数 |
| `staff` | 自动推导：店铺负责人和在职员工的账号绑定的平台身份 `{provider, subject}` |
| `currencyName` | 自动推导：店铺余额资产的名称 |
| `door` | 资源上选择的门锁；没选时若店里只有一个门锁就用它 |
| `mahjongTables` | 自动推导：带麻将能力的资源，含名称、别名和开桌人数（即资源的容量） |
| `billingEnabled` | 自动推导：通过这个 Bot 入场是否计费，即 Bot 资源有专属方案或所在资源组有方案。沿用旧的整店开关字段名，供已发布的插件读取；店铺本身已没有计费开关 |

机器人连上 WebSocket 后先读取这份配置，再发送 hello（名称和闲置提醒提前量取自配置）。**监听 Home Assistant 不是店家的开关**：能连上 Home Assistant 的 Bot 一律在 hello 里声明，由平台按店铺的监听名额自己挑谁在听、听哪些连接；换人、断线、停用都由平台调度，店家不用管。商家保存任何资源、修改资源组的计费方案、修改默认计费方案、快速创建计费、导入店铺数据，以及员工通过机器人绑定平台身份后，Hub 会向所有在线机器人推送 `{"type":"config.changed"}`，机器人重新读取并再发一次 hello；不再允许监听时，它正在监听的 Home Assistant 会交给下一个监听者。Bot 资源被停用时该接口返回 `403 BOT_DISABLED`。

Bot 和其他资源一样属于一个资源组，也可以设置专属方案（资源编辑页的「计费」一节）。玩家通过它 `/login`、`/入场` 时，开始的就是这个 Bot 的方案，规则与扫码一样：专属方案优先，否则用所属资源组的方案。没有改过的 Bot 在默认资源组，开始店铺默认计费方案。一家店可以有多个 Bot，例如麻将群的 Bot 放在麻将区，入场就开始麻将区的方案。Bot 所在资源组的方案只决定入场；Bot 替玩家操作其他资源时，检查的仍是目标资源的方案。Bot 所在资源组没有方案、Bot 也没有专属方案时，Bot 资源免费，`/login`、`/入场` 返回 `409 RESOURCE_NOT_BILLED`（插件提示「这里不计费，无需入场」）。配置里的 `billingEnabled` 只描述这个 Bot 自己。新版插件只用它拦截 `login`／`入场`：为 `false` 时不请求平台，直接回复「这里不计费，无需入场」；钱包、账单、结账、兑换、上下桌、`list` 等命令属于玩家或各自的资源，一律交给平台判断。旧版插件（0.3.1 及以前）用它拦截所有计费类命令，Bot 在免费资源组时这些命令都会回复「本店未启用计费」，升级插件后恢复正常。方案变化后平台会推送 `config.changed`，Bot 重新读取，缓存的值不会过期。

### 按外部身份上下麻将桌

- `POST integration/players/by-identity/mahjong`，`{identity, table, action: "join" | "leave"}`。`table` 可以是麻将桌资源的 ID、名称或别名。上桌即玩家本人的确认：服务端会开始这张桌资源的计费方案（以及它依赖的方案），满桌时为所有人开台；不需要先入场。返回 `{mahjong: {capacity, seats}}`。错误：`MAHJONG_TABLE_NOT_FOUND`、`MAHJONG_TABLE_FULL`、`MAHJONG_ALREADY_SEATED`。
- `GET integration/mahjong-tables`：每张桌的座位 `{playerId, name, playing}`，供机器人列名单和不带桌名的下桌。
- 下桌只结束座位当前所在的 session（已开局为麻将方案，等位中为麻将桌自己的等位方案），响应带 `billing.remaining`：还在计费的方案名，机器人回复「仍在计费：…」。见 [卡片、占用与查人](occupancy.md#3-麻将等位)。
- `GET integration/roster` 列出在店的人：每人只列一处，正在占用的资源（麻将桌和其他游戏机一样，带人数/容量）或最具体的方案；`?name=` 只列一个资源或一个方案。机器人的 `list` 按它输出，不再自己拼麻将桌。`POST integration/players/by-identity/presence` 回答一位玩家是否在店、计费哪些方案、占用哪些资源。`GET integration/sessions/active` 的每条 session 带 `pricingConfigId` 与 `planName`。

### 常用玩家动作

### 在场客流与设备状态

机器人对自己投资的入口可以读取「在场玩家」和店内设备上报：

| 路由 | 用途 |
| --- | --- |
| `GET /rpc/integration/roster` | 在店的人，每人只列一处（见上文）。每位成员带 `displayName` 与 `identities` (provider+subject)；认不出主人的刷卡不产生占用，不会出现在这里。机器人在 `/list` 里用 `identities` 中的 `subject`（平台用户 ID）去调用聊天平台 API 拉昵称，而不是直接显示后台存的 `displayName`。 |
| `GET /rpc/integration/sessions/active` | 列出在场所有活跃 session，含 `playerDisplayName`、`identities`、`startedAt`、`label`、`elapsedMinutes`、`pricingConfigId`、`planName`。 |
| `GET /rpc/integration/device-states` | 列出每台已启用、绑定了电源的设备的电源状态。设备所在的 HA 连接处于事件驱动时读存储的事实，**不去问 Home Assistant**；无状态时才现场读取 Home Assistant 且不记录（电源可能在平台外被改动，所以这时每次请求都会现查，会变慢）。`state` 为 `on`/`off`；读不到时 `status` 为 `offline`、`state` 为最后一次存储的值或 `unknown`。`metadata.aliases` 为设备别名。bot 的 `/show` 直接消费。（插件原来的无人自动关机 `powerOffInterval` 已删除，改为后台的「闲置自动关机」。） |

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

示例：平台用户第一次发送 `/入场`，不存在就自动注册，并开始这个 Bot 的计费方案：

```bash
curl -X POST https://prism.example.com/rpc/integration/players/by-identity/session/start \
  -H "Authorization: Bearer <integration-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "identityKey": "onebot:123456",
    "autoRegister": true,
    "displayName": "onebot:123456"
  }'
```

开始哪个方案只由发请求的 Bot 资源决定（见上文「Bot 是一种资源」）；请求里的 `pricingConfigId`、`pricingConfigIds`、`label`、`entry` 都会被忽略。麻将由上下桌接口开始和结束计费，不再由机器人另开 session。无论请求里的 `autoRegister` 如何设置，服务端都以店铺是否允许自动注册为准。

机器人、店员后台、前台收银和扫码确认都走同一个开始入口（`resourceBilling.activate`），结果相同；响应的 `billing.stopped` 列出因互斥被结束的方案，机器人在回复里列出。Bot 在默认资源组、店铺又没有设置默认计费方案且启用了多个计时方案时会被拒绝（`ENTRY_PRICING_REQUIRED`）；所在资源组停用时返回 `RESOURCE_GROUP_DISABLED`。在场就是有进行中的 session，在哪个场由 session 的方案区分：响应带 `created` 与 `planName`，`created: false` 表示这个方案在这次请求之前就在计费（例如已在「普通游玩」中），返回的是原 session。机器人对设备的操作要求该设备的计费方案在玩家这里计费中，否则返回 `DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION`。

如果 `autoRegister` 为 `false` 或未传，而身份没有绑定玩家，接口会返回 `PLAYER_IDENTITY_NOT_FOUND` 和 HTTP 404。

`POST /sessions/:sessionId/stop` 用于结束某一条 session 的计时但不结账。麻将不再由机器人自己开 session，改用下面的上下桌接口，座位和开台都由服务端管理。它会把 session 关闭并标记为待结算，不会扣款；依赖该方案的其他 session 会在同一时间点一并关闭（见[计费状态编排](pricing-sessions.md)）；玩家最终离店时，统一结算会把仍在运行的 session 和已经停止但未结算的 session 一起计算。

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

`coin`、`aime.scan`、`power.on` 和 `power.off` 都要求玩家当前至少有一条正在运行的计费 session。未入场时接口返回 `DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION`。Bot 不接收游戏机内部 ID 或 Aime 卡号：游戏机通过后台配置的 `name` / `aliases` 解析，刷卡用的是玩家在本店最近用过的卡（加密保存在 `player_cards`，见 [卡片、占用与查人](occupancy.md#1-卡片)）；请求指明卡号时只在它属于该玩家时使用。Bot 配置为关机仅管理员可用时，只允许白名单管理员提交 `power.off` 请求，并附加 `staffOverride: true`；`power.on` 仍要求玩家已入场。后端将覆盖请求记录为员工动作。该覆盖只接受 `power.on/off`，不能用于投币、刷卡或其他设施动作。

旧的 `botToken + playerToken + staffToken` 普通命令模式已经废弃。Integration Token 可调用受限的管理员快捷操作接口：按外部身份调整玩家资产（`POST /rpc/integration/players/by-identity/assets/adjustments`）和按指定总价立即结账（`POST /rpc/integration/players/by-identity/checkout/override`）。这两个接口不授予完整 Staff API 权限；机器人仍必须在自身配置中限制可发起该操作的平台管理员。麻将上桌、下桌这类玩家业务命令不需要额外权限。

---

## 2. 设备：能力、动作与事件

一台设备（`machines`）只表示身份：名称、别名、二维码 `public_id`、是否启用。它能做什么由绑定的**能力**决定，每个能力是 `device_capabilities` 的一行：

| 能力 | 配置（`config_json`） | 密钥（`secret_json`，每个值单独加密） | 动作 | 设备回报 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `power` | `connectionId`、`entityId`（`switch.*`/`input_boolean.*`） | —（旧绑定：`binding`，见下文「店铺 Home Assistant 连接」） | `power.on`、`power.off` | — | `power`，外部权威（事件驱动读存储，无状态现查） |
| `climate` | `connectionId`、`entityId`（`climate.*`） | —（同上） | `climate.on`、`climate.off`、`climate.set_mode`、`climate.set_temperature`、`climate.set_fan_mode` | — | `climate`，外部权威（同上） |
| `hinata_io` | `transport`（`external`/`embedded`）、`coinKey`、`coinAfterSwipe`、`channel` | `url`、`password`（仅外部中继） | `aime.scan`、`coin` | `card.state`、`card.consumed`、`card.login`（由读卡器灯光推出）、`led.set`（不存） | `link`，平台权威 |
| `door` | `lockId` | — | `door.open` | — | — |
| `mahjong` | `capacity`、`pricingConfigIds`（最多一个方案） | — | —（上下桌走麻将流程） | — | — |

**空调（`climate`）单列一个能力，不并入电源**：它的状态是模式和温度而不是开/关；用空调不算「玩过」机台（所有空调动作 `countsAsPlay: false`，不会取消入场的免费宽限）；空调关着也不应该挡住机台投币、刷卡（那只看 `power`）。一台设备可以同时带电源和空调（例如包间：灯电源 + 空调）。

- 动作对应 Home Assistant 的 `climate/turn_on`、`turn_off`、`set_hvac_mode`（`mode`）、`set_temperature`（`temperature`）、`set_fan_mode`（`fanMode`）。可选的模式、风速、温度范围和步长不写死，每次从实体的 `hvac_modes`、`fan_modes`、`min_temp`、`max_temp`、`target_temp_step` 读取；实体不接受的值由 Home Assistant 拒绝，操作记为失败。
- 状态读取：`GET /api/v1/merchant/machines/:id/state`、玩家页首屏接口 `GET /api/v1/devices/session/bootstrap`（`state.device.climate`）和 `GET /api/v1/devices/session/device` 都返回 `climate`（`{ mode, modes, temperature, currentTemperature, minTemperature, maxTemperature, temperatureStep, fanMode, fanModes }`，未知为 `null`）。事件驱动时读存储，无状态时现读 HA（后台看板的两个接口都是这样，没有开关）。只把**设定**（模式、目标温度、风速）记为 `change` 事件；室温会自己漂移，完整视图另存为不记事件的 `climate/view`。
- 玩家扫码后能做全部空调操作（含关空调）；空调所在资源设置了计费方案时要求先入场，和其它设备动作一样。`power.off` 仍然仅限店员。开启位置校验后，每个空调动作都和机台操作一样要求在店内（`checkShopLocation(…, "machine")`），后台店员操作不校验。
- 玩家页是独立的空调卡片（`PlayerClimate`）：关着时只有「开空调」；开着时中间是大号设定温度和 −/+，下面是带图标的模式分段和风速分段，卡片颜色随模式变化（制冷蓝、制热橙等）。其它按钮实时发送；−/+ 在停下 1 秒后合并成一次 `climate.set_temperature`，连按会重新计时，避免每一步都重新定位、都调用一次 Home Assistant。选择立即显示：事件驱动时以推来的实际状态为准，6 秒内未回报则回到实际状态；无状态时 HA 回 200 就算完成，页面保留所选的值，不再核对。后台操作面板沿用同一套逻辑，样式更紧凑。
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
- **旧连接补建**：只读账号只在新建连接、改连接的地址或令牌时自动创建，而功能上线之前存下的连接是第一次读取时由旧绑定「采纳」出来的，`readAccess` 为空，从没有人尝试过，编辑器里会一直显示「正在启用实时状态…」。所以店铺 Hub 在构建监听任务时（IO 上线、设备或连接变化、闹钟补位都会走到），对**有设备在用、`readAccess` 为空**的连接补建一次：用控制令牌走上面的流程，成功后立刻重建监听。补建放在 Hub 里而不是请求里，因为每个店铺只有这一个对象，能看到「已经在跑」，同一条连接同一时间只会跑一次；两次并发会在 HA 里各建一个用户，先建的那个留下仍然有效的令牌。结果是 `needs_admin` 或 `failed` 的不会再自动重试，由编辑器提示原因。没有 IO 在线的店铺不会触发，也就不会在没有人需要实时状态时去动店家的 Home Assistant。
- 依赖 Home Assistant 默认的用户名密码登录方式；店家关掉它时这一步失败，需要手动提供令牌。只读用户仍可调用少数不针对实体的服务（如发通知），但控制不了任何设备。整条流程已在真实 Home Assistant（官方 docker 镜像）上跑过：管理员令牌得到 `ready`，非管理员令牌得到 `needs_admin`，IO 固件用只读令牌订阅事件并收到完整快照；见 [开发环境](dev-environment.md#真实-home-assistant-与-hinata-io-的端到端测试)。

能力目录写在 `packages/server/src/resources/capabilities/catalog.ts`，是唯一的定义处：配置校验、动作是否算作「玩过」（计费宽限用）、哪些回报要存、状态由谁权威，都在这里声明。数据库里没有能力名或事件类型的 CHECK 约束，新增能力不需要改表。

### 动作、副作用与事件

- **动作**是平台向设备提出的请求（意图）。每次动作记为一条 `device_operations`，同时写入一条 `request` 事件；执行后写 `result` 事件并结算为 `succeeded`/`failed`。网络超时等**无法确定结果**的情况保持 `pending`：设备可能已经动作了，计费一直把未结算的请求算作使用。
- **副作用**是现实中发生的事（机器开了、卡进了游戏），平台不能直接观察。
- **事件**是平台记录下来的事实（`device_events`，只增不改）：`request`/`result`（平台发起）、`signal`（设备回报，如 `card.consumed`）、`change`（状态变化，如电源从开到关、机台上线/掉线）。
- 设备回报 `card.consumed` 时，会把对应的 `aime.scan` 操作标记为 `confirmed_at`（只认本设备的操作）。
- 状态（`device_state`）只在值变化时写一条 `change` 事件。电源和空调是**外部权威**：真相在 Home Assistant。一个连接被监听者订阅时（事件驱动），每个事件写入 `device_state`，存储的值就是事实，读者只读存储；没有人监听时（无状态）设备没有已知状态，读者现查 HA 且不记录，存储里残留的旧值被忽略（见「店铺 Hub」）。直连链路 `link` 是**平台权威**，由中继在连接/断开时写入。
- 以后要做「空闲/忙碌」这类派生状态时，应当监听**事件**（包括设备回报和观测到的变化），而不是只看平台发出的动作。

所有写入都经过 `packages/server/src/resources/capabilities/bus.ts`：`perform`（动作）、`signal`（回报）、`setOwned`（平台权威状态）、`reportMany`（监听者上报的外部状态，一批写入，可只存储不记事件）。`observe`（现读后写入）仍在总线上但不再用于任何读取路径。动作不会在完成后读回外部状态。其他代码不直接写设备表。卡号只作为临时参数交给执行器，从不落库；门锁临时密码只在本次响应返回。

### 设备看板与编辑器（Web）

商户后台的资源页按「资源是身份、能力是配置」组织，与服务端能力目录一一对应：

- 设备卡片只陈述三件事：设备身份（名称、别名、启用状态）、已绑定的能力徽章、实时状态（电源、空调模式与温度、直连在线）。**每个带电源或空调的设备有一个「实时 / 非实时」标签**：「实时」表示它用到的 Home Assistant 连接有 HINATA IO 监听者订阅着并交付了完整状态，显示的值是推来的事实；「非实时」表示设备没有自己的状态，显示的是最近一次读到的值。**非实时设备不会是「未知」**：进入页面后看板对它读一次，之后即使这个值已经落后了十分钟也照样显示，只有从没读到过的字段才是空（读取期间显示「读取…」；读不到才是「未知」）。一台实时设备变成非实时（连接不再被监听）时保留它最后一次的值，只把标签换成「非实时」。是否实时由监听者对 HA 连接的订阅决定，不是看板自己的这条连接。门锁、麻将桌这类没有电源和空调的设备没有标签。
- **实时设备的状态完全靠 Hub 推送，看板和面板都不去读它。** 进入资源页后连上店铺 Hub 的一条 WebSocket：连接建立时 Hub 发整店的当前状态（含每台设备实时与否），之后每台实时设备的变化（电源开关、空调设定和室温）推过来，页面直接更新；哪些设备是实时的发生变化时（有连接开始或停止被监听），Hub 重发整店。Hub 只给看板推实时设备的变化，一个连接的第一份快照也不是逐台推的变化，而是以整店状态的形式在宣布该连接实时之后发一次，所以客户端不做过滤，收到变化就更新它指的那台设备。对实时设备执行操作后**什么都不读**，操作的结果会作为事件自己推过来；只重载设备列表（名称、绑定等）。
- **非实时设备靠主动读取，读的就是 Home Assistant。** 进入页面、看板拿到第一份状态后，对所有非实时设备读一次（`GET …/machines/states?shopId=`，没有任何开关：实时设备返回存储的事实，非实时设备没有存储的状态，所以去问它们的 Home Assistant，不记录）；页头有一个店铺级的「刷新设备状态」按钮再读一次，**只对非实时设备有作用**，实时设备原样不动（Hub 一直让它是当前的，读取带回的只是读取时数据库里的值，客户端不采用）；全部设备都是实时时按钮禁用。对一台非实时设备在「操作」面板里执行开关机或空调操作后，重读**这一台**一次（`GET …/machines/:id/state`），因为没有别的途径能说明操作的结果；读到的值写回看板，面板和卡片显示同一份。HTTP 读取只有这三种用途，外加 Hub 没给出状态时的兜底（连不上或连上后 3 秒内没有任何状态，按进入页面的方式读一次整店）。**实时设备没有任何读取，连接断开期间也没有**：连接断开后按 5、10、20、60 秒递增重连，Hub 在重连成功时重发整店状态，实时设备靠它补上断开期间错过的变化；断开期间看板显示的是断开前的值。「操作」面板的电源和空调直接取看板已有的状态，打开时不读；麻将座位不是 Home Assistant 状态，没有推送，面板用 `GET …/machines/:id/mahjong` 单独读。卡片底部是「操作」（主按钮）、「编辑」、「操作记录」和二维码入口；有可执行能力的设备才显示「操作」，只读账号不显示。
- **下发操作与历史记录是两个入口**：`操作` 打开只含开机/关机/投币/开门密码的确认面板，`操作记录` 打开只读的事件时间线。两者混在一个弹窗里会让有后果的按钮看起来像记录的一部分。
- 编辑器分两段：**设备身份**（名称、别名、启用）和**设备能力**。每项能力是一张带开关的卡片——电源、空调、刷卡（外部中继或直连）、开门密码、麻将桌；关闭的能力不渲染其表单，避免四种凭据同时铺开。提交按钮吸底，长表单无需滚到末尾才能保存。
- 直连模式（`transport: "embedded"`）的令牌是**显式签发的**：面板里只有「签发设备令牌 / 轮换设备令牌」按钮，普通保存不会顺手创建凭据；未签发就保存会被拒绝并提示先签发或改用外部中继。签发成功后弹窗切换为一次性交付步骤，显示令牌、可复制的两行 INI 片段（`serverUrl=` / `deviceToken=`），在点击「我已写入机台」之前关闭按钮禁用。轮换前明确提示机台现有令牌会立即失效。
- 空资源页说明「资源」是店里玩家扫码就能用的东西（机台、门、麻将桌，或没有硬件、只用来开始计费的二维码）；`/merchant/:shop/resources?add=1` 直接打开添加资源弹窗（开店指引使用；旧地址 `/devices` 会跳转过来）。二维码弹窗提供「打印」（新窗口只含二维码和资源名）、带「已复制」反馈的复制链接和测试扫码入口。NFC 入口就是把同一个链接写进标签的 NDEF URI 记录：iPhone 碰一下会唤起 hinata_go 里的 PRiSM Link App Clip（免安装），其它手机用浏览器或 HINATA Go 打开；弹窗下方写明了这一点。
- 编辑器里开门密码能力会检查店铺 TTLock 账号：未连接时红字提示并链接到「设置 → 位置与设备」；麻将桌没有可选计费规则时链接到「计费」页；麻将桌所在资源没有计费方案时不要求选择对局方案，入座免费；外部中继缺连接密码时说明投币为何不可设置。
- 能力判定集中在前端适配层 `packages/prism-web/src/ui/merchant/resource-capabilities.ts`（`resourceCapabilities`、`canOperateCoin`、`deviceActions`、`deviceSummaryKey`）。卡片徽章、操作记录里的可用动作、编辑器里的开关都读这一处，不再各自从 `ttlockLockId`/`homeAssistant`/`hasHinata` 推导。
- 提交仍使用商户 API 的扁平字段（`homeAssistant`、`ttlockLockId`、`mahjong`、`hinataUrl`/`hinataPassword`、`relayConnection`、`coinKey`、`coinAfterSwipe`）；关闭某项能力时发送 `null`（刷卡为 `relayConnection: "external"` + `hinataUrl: null`）让服务端删除对应能力行。适配层只是视图模型，不改变接口契约。

### 「操作」面板

- `GET /api/v1/merchant/machines` 的每台设备带 `actions`：能力目录里当前可用的动作，形如 `{ name: "power.on", capability: "power" }`。后台「操作」面板按 `capability` 分组渲染（电源控制 / 刷卡·HINATA IO / 开门密码 / 麻将桌），**新增能力不需要改前端**；前端只在接口没有 `actions` 时退回本地推导。
- 空调分组（`ClimateControls`，与玩家扫码页共用）：开/关空调，以及按实体上报的模式、温度加减（按步长、限制在最低/最高温度之间）和风速，单击即下发；标题右侧显示「模式 · 设定温度 · 室温」。
- 每个分组标题右侧显示与该组操作相关的状态：电源为实时 `power`（已开机/已关机/未知），直连刷卡为链路在线状态（外部中继则显示连接方式），门锁显示 `lockId`，麻将桌显示 `已入座 / 容量`。
- 麻将上桌的候选人来自 `staff/live-players`（已入场在店玩家），已入座的人不重复出现；上桌要求该玩家有进行中的入场，所以全量玩家列表里大多数人本来就会失败。
- 刷卡由店员直接输入 **20 位卡号**（`cardNumber`）发送；也可以传 `playerId`，平台解密该玩家在本店最近用过的卡，这次操作同时记为该玩家占用这台机台。卡号只作为临时参数交给执行器，不落库；卡号格式不合法返回 400，玩家没有绑定卡返回 `SCAN_IDENTITY_NOT_BOUND_TO_PLAYER`。
- `mahjong.seat` / `mahjong.unseat` 接受 `playerId`，让所选玩家上桌/下桌。上桌与玩家自身上桌走同一套校验：玩家必须启用、计费开启时必须有进行中的入场（`CHECKIN_REQUIRED`），麻将计费规则必须齐全且处于可计费时段。店员操作不校验店员自身定位，但玩家资格、封禁与牌桌容量照常校验。
- `GET /api/v1/merchant/machines/:id/mahjong` 返回 `{ mahjong }`；`mahjong` 为 `{ capacity, seats: [{ playerId, name, playing }] }`，供操作面板显示座位并选择下桌对象。没有麻将能力的设备返回 `null`。电源和空调的状态是另一个接口 `…/:id/state`，见「读取的接口」。

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
- 机台通过同一连接回报 `event.cardStateChanged`、`event.cardConsumed`、`event.ledSet`，分别记为 `card.state`、`card.consumed` 信号；`led.set` 每帧都有，不存储。下发刷卡时平台把操作 ID 放进 `source`，机台原样回传；只有 UUID 形式的 `source` 被当作关联，`Remote`、`HINATA(<实例>)` 等机台本地来源不关联任何操作。卡片事件带着卡号（包括玩家直接在读卡器上刷的实体卡）：平台用它认出卡主人、记在事件的 `player_id` 上，并推断谁在占用机台，存入日志前去掉卡号，只留卡类型。
- 机台断线重连时，平台只重发**仍在有效期内、且还没被游戏取走**的那张卡（客户端默认 3 秒后丢弃远程卡）。游戏取走后（`source` 一致的 `card.consumed`）或过了有效期，存着的卡就被删除；旧版本存下的、没有有效期的卡一律不重发。否则机台几小时后重启，会把上一位玩家的卡再塞进游戏。

#### 扫码刷卡的结果

玩家在扫码页刷卡（`POST /api/v1/machines/login`）时，直连机台会等到游戏给出结果再返回：

1. 发卡前先在 `MachineRelay` 内存里登记等待，再下发 `SET_CARD`；等待期间请求未返回，对象不会休眠。
2. 约 4.5 秒内收到 `source` 一致的 `event.cardConsumed`，记下是哪个读卡器（`unit_no`）取走的；收不到就是 `not_read`（游戏不在读卡，卡已作废）。
3. 之后约 15 秒内，**同一个读卡器**的 `event.ledSet` 变成 `0000FF` 记为登录成功（`ok`），变成 `FF0000` 或 `FFFF00` 记为被拒（`failed`），并存一条 `card.login` 信号（`payload.result`）。等不到这三种颜色就是 `read`：游戏拿到了卡，但没有给出结论。
4. 新卡会顶掉机台上还没被取走的旧卡，旧卡的等待随即以 `not_read` 结束。

响应新增 `card` 字段：`ok`、`failed`、`read`、`not_read`；外部中继收不到任何回报，记为 `sent`。旧客户端忽略这个字段。开启「刷卡后自动投币」时，`not_read` 和 `failed` 不投币，`coin` 返回 `skipped`，`reason` 分别为 `CARD_NOT_READ`、`LOGIN_FAILED`。扫码页在卡片行的说明文字里显示「登录成功」「登录失败」（`failed` 和 `not_read` 都显示这个）「已刷卡」，投币结果接在后面（如「登录成功 · 投币失败」）；结果停留几秒，期间其它卡片和投币按钮照常可用。`card.consumed` 只说明游戏从读卡接口拿到了卡号，灯光颜色才反映游戏服务器的结论。

### 店铺 Hub：谁替店里盯着 Home Assistant，以及设备状态的两种模式

每家店有一个 `ShopHub` Durable Object（binding `SHOP_HUB`，迁移 tag `shop-hub-v1`，名字是店铺 ID），它从店里**在线的 Bot 和直连 HINATA IO 中挑最多两个**（默认两个，平台管理员可按店铺调整，见下），让它们用只读令牌订阅 Home Assistant（`subscribe_entities`），把状态变化经已有的连接报回来。HA 不必暴露到公网（监听者在局域网里也行），机台连进来的 WebSocket 照常可以休眠。Bot 的 WebSocket、玩家资源页和商户看板的 WebSocket 都进这个对象；只有机台直连走每台一个的 `MachineRelay`。

#### 两种模式（按 Home Assistant 连接）

- **事件驱动**：一个 HA 连接被至少一台存活的监听者订阅着、并且那台已经交付了完整状态时，`ha_event_connections` 里有它的一行。此时 `device_state` 就是**事实**：玩家页的首屏接口、后台设备看板、Bot 的 `device-states`、投币前的电源检查都直接读 D1，**不再去问 Home Assistant**，也就不需要信任或过期的判断。
- **无状态**：其余情况下设备没有已知状态。需要状态的读者自己现查 Home Assistant，**不写入任何状态或事件**；只有平台自己发起的动作（开关机、空调）会写 `request`/`result` 事件。闲置自动关机不依赖设备的实际状态，所以不受影响（见下）。后台设备看板给这样的设备打「非实时」标签，它的值靠看板主动向 HA 读（进页面、刷新按钮、操作后），见下。

连接进入事件驱动要同时满足：监听者的租约有效（90 秒内有上报）、它对这个连接最近一次 `ha.status` 是已连接、当前这一任期已交付该连接的全量状态。**先把状态写进 D1，再把连接宣布为事件驱动**；任何一条不满足就回到无状态。只有 ShopHub 判定模式，`ha_event_connections` 只在切换时写。模式变化会通过 WebSocket 推给相关的玩家资源页（`watching` 帧）。读者拿到的 `watching` 是设备用到的所有连接都处于事件驱动；值为 `null` 表示 HA 报告不可用（`unavailable`/`unknown`），不当作开也不当作关。

#### 监听者

- **谁能被选**：`CLIENT_HELLO` 的 `body.features` 含 `ha.watch` 的机台。`MachineRelay` 收到这样的 hello 就告诉 Hub 自己上线（`relayOnline`），最后一个这样的连接断开时告诉 Hub 下线（`relayOffline`）。网关把通道名放在 `x-prism-relay-channel` 头里交给 `MachineRelay`，Hub 用它回头找到这台机台。
- **选谁**：名额是这家店的监听器数量（默认 2，平台管理员可改，见下）。**Bot 优先于机台**：一个 Bot 在线就占一个名额，两个 Bot 就占满，机台只补空位；同类里在线最久的优先；刚失败过的（连不上 HA、没能下发、租约过期）5 分钟内排在后面，不论是 Bot 还是机台，所以一个连不上 HA 的 Bot 不会把名额一直占着。两个监听者同时报同一个事件，谁先到谁生效，另一份按下面的去重丢弃，不分高低。第二个名额的作用是**不让状态断流**：一个掉线时另一个仍在报，模式不会闪回无状态，空出来的位置由下一个在线的候选补上。令牌只在监听者的内存里。
- **让位没有空窗**：Bot 上线或名额调小，会让原来在监听的机台被「挤出去」。被挤的监听者要等**留下的监听者对每条已宣布为事件驱动的连接都交付了完整状态**才收到 `HA_UNWATCH`；在那之前它继续报，每一份新的全量状态到达时 Hub 再判断一次。所以只有一个名额时，Bot 先交完全量，机台才退出，连接不会闪成无状态。
- **Bot 作为监听者**：Koishi 插件的 `hello` 带 `{ha: true, name}` 才会被考虑（旧插件不声明，永远不会被分配）。Hub 用 `bot:<连接 id>` 记它，下发 `{"type":"ha.watch","watch":{term,connections}}`（内容与机台的 `HA_WATCH` 相同）、撤销 `{"type":"ha.unwatch"}`；Bot 上报 `{"type":"ha","method":"ha.status|ha.states","params":{…}}`，字段与机台一致，所以后面的任期、租约、去重、记录对两者完全相同。Bot 的连接断开（包括出错）立即让位给下一个候选；部署会让连接静默丢失，每次重新分配时都会对照仍在线的 Bot 连接清理，不等租约。Bot 重连是一个新连接、新 id，要重新 hello 才再被分配。监听名额由平台分配，店家不设开关；Bot 只要能连上 Home Assistant 就会被考虑。
- **下发**：`{"action":"HA_WATCH","body":{"term":3,"connections":[{"id":"ha_…","urls":["http://ha.local:8123","https://ha.example"],"token":"<只读令牌>","entities":["switch.a","climate.b"]}]}}`。`urls` 按顺序尝试，店内地址（HA 的 `internal_url`）在前，所有监听器收到的是同一个列表，平台不区分它在哪、是什么：HA 可能托管在别处，监听器也可能在店外，哪个地址通就用哪个。监听器侧每个地址有 10 秒连接超时，上次连上的排在最前，一轮全部失败才上报断开（见固件 `docs/remote-protocol.md`）；真实环境实测内部地址不可达时 10.2 秒变成实时（没有超时时是 75.2 秒）。每次下发用新的任期号。换人时给原来那台发 `{"action":"HA_UNWATCH","body":{}}`。只有已经签好只读账号、且有设备用到的连接会下发；一条都没有就不选人。
- **上报**（JSON-RPC 通知，无 `id`）：`ha.status {term, connection, connected, error?}`，订阅建立或断开时、以及每 30 秒一次作为心跳；`ha.states {term, connection, full, states:[{entity_id, state, last_changed, last_updated, attributes}]}`，第一次是全量，之后只报变化；时间是 HA 压缩状态里的 Unix 秒（也接受 ISO 文本），`attributes` 只带平台用到的空调属性。任何上报都给租约续期 90 秒；`term` 不是该监听者当前的任期，一律丢弃，所以交接时新旧两个任期短暂同时上报也无害。
- **去重与乱序**：两台监听者看到同一个事件，只记一次。Hub 按每个实体最近一次已应用的 `last_updated`（旧固件没有这个字段时退回 `last_changed`）判断：不比已应用的新就丢弃，所以一台晚到的旧事件不会把状态改回去。`last_updated` 要单独带，因为空调的温度、风速变化不会动 `last_changed`。设备事件的去重另有 SQL 保证：状态值没变就既不写事件也不写状态。两份报告同一时刻到达时 Hub 一份一份处理（`haReport` 排队），第二份要等第一份存完才判断，否则两份都会认为事件是新的、各推送一次。
- **换人**：监听者下线时立即补位；90 秒没有任何上报，Hub 的 alarm 把它排到后面并补位。**平台自己把监听者所在的机台关机**（玩家、店员、闲置自动关机的 `power.off` 成功后），Hub 立刻认定它下线（`markDown`），不等租约，且在它再次 hello 之前不再选它。`ha.status` 报告连不上 HA 而店里还有没在盯的候选，立即换人；没有候选就保留，该连接回到无状态直到它重新订阅并交付全量。部署会让所有连接断开且没有关闭回调，也靠租约兜底。
- **记录**：上报的状态一批写入 D1（`bus.reportMany`，一次往返）。电源写 `power/power`（`on`/`off`/`null`）；空调写两个键：`climate/climate` 只含设定（模式、目标温度、风速），变化时记 `change` 事件，`climate/view` 是完整视图（含室温、可选模式、范围），只存储不记事件，因为室温会自己漂移。**时间用 HA 的 `last_changed`**，所以在米家或物理按钮开机，也能知道真正的开机时间。写入失败时不宣布该连接，并让监听者用新任期重新订阅（30 秒内最多一次），换回一份全量状态重写。
- **成本**：每次心跳只写一行存储（租约），且不重设 alarm，只在租约可能到期时才醒来；设备状态本身只在变化时写 D1。

#### 监听器数量与看板上的监听器区域

- **数量只有平台管理员能改，范围是单个店铺。** `PUT /api/v1/merchant/ha-watchers?shopId=`，body `{"count": 1–4}`，非管理员（包括这家店的店主）返回 403，越界或不是整数返回 422，店铺不存在返回 404。存在这家店的 `app_settings`（键 `devices.ha_watcher_limit`），默认 2，上限 `MAX_WATCHERS = 4`。写入后 Hub 重读（`refresh`），名额变大就补人，变小就按上面的规则让位。限制值读不出来或越界一律回到默认。
- **看板能看到谁在监听。** 资源页（有带电源或空调的资源时）的「HA 监听器」区域，数据来自看板那条 WebSocket 的 `watchers` 帧：`{"type":"watchers","limit":2,"max":4,"standby":1,"watchers":[{"id":"bot:…","kind":"bot","name":"前台","state":"watching"},{"id":"<机台 ID>","kind":"device","deviceId":"<机台 ID>","state":"starting"}]}`。连接建立时发一次，之后只在内容变化时发（监听者上线、让位、报告连不上 HA、数量变化）。Bot 排在前面，用它 hello 里的名字；机台用资源页已有的资源名。`state` 是 `watching`（已交付完整状态）、`subscribing`（已订阅、完整状态还在路上）、`starting`（刚下发）、`unreachable`（报告连不上 Home Assistant）；租约过期的不列。`standby` 是在线但没拿到名额的候选数。没有任何监听者时区域写明设备状态是非实时。
- 所有人都能看到这个区域和名额；下拉框只对平台管理员显示，店主看到的是「由平台管理员设置」。

#### 读取的接口

- `GET /api/v1/devices/session/bootstrap?ticket=`：扫码首屏一次请求拿到机台和（已登录时）页面状态；页面状态里的 `device: { watching, power, climate }` 是**已知的事实**，不问 HA。启用计费的店铺里，任何资源（包括没有硬件的二维码）的方案未在计费时 `gate` 为 `entry`，`billing.preview` 列出确认后开始、结束和继续的方案及 `revision`，无法计费时为 `billing.error`；见 [资源与资源组](resources.md)。`/session/state` 同样带 `device`；它的 `includePower` / `includeClimate` 默认仍现读 HA，给没升级的旧客户端用，新客户端传 `=0`。
- `GET /api/v1/devices/session/device?ticket=`：无状态时页面自己取一次状态；事件驱动时直接返回事实。无状态时电源和空调并发去问 HA，且不记录。`/session/power` 语义相同，只返回电源。
- `GET /api/v1/merchant/machines/states?shopId=`：看板的整店读取，用于**进入页面时对非实时设备读一次、刷新按钮、Hub 没给出状态时的兜底**，不是实时设备取状态的路径。返回 `{ states: { [deviceId]: { watching, power, climate } } }`，只含带电源或空调的设备，用两条 D1 查询读出存储的事实。`watching` 为真的设备返回存储的事实；`watching` 为假的设备没有存储的状态，所以去问它们的 Home Assistant（并发上限 4，不记录），问不到的是 `null`，客户端对它保留已有的值；`watching` 为真的设备客户端不采用读取的值。没有任何开关参数。店铺成员可读，非成员 403，缺 `shopId` 为 400。
- `GET /api/v1/merchant/machines/:id/state`：单台设备的电源和空调，**只用于对一台非实时设备执行开关机或空调操作后重读这一台**。返回 `{ watching, power, climate }`：实时设备返回存储的事实，非实时设备去问 HA。实时设备不用它。
- `GET /api/v1/merchant/machines/:id/mahjong`：返回 `{ mahjong }`（`{ capacity, seats: [{ playerId, name, playing }] }`，没有麻将能力为 `null`），给操作面板显示座位并选择下桌对象。座位不是 Home Assistant 状态，读它不会去问 HA。
- `GET /api/v1/merchant/machines/ws?shopId=`（WebSocket 升级）：看板的实时通道，连到该店的 Hub。只给店铺成员（非成员 403，缺 `shopId` 400，没有 `Upgrade` 头 426）；浏览器带了 `Origin` 就必须是平台自己的来源（`APP_ORIGIN` / `EXTRA_ALLOWED_ORIGINS`），否则 403，因为会话是 Cookie。路由把店铺 ID 和 `x-prism-hub-board` 交给 Hub 并去掉 `Authorization`，Hub 以 `board` 标签接受连接。帧：`{"type":"states","states":{<deviceId>:{watching,power,climate}}}`（连接建立时、以及哪些设备是实时的发生变化时重发整店，包括有连接开始或停止被监听）；`{"type":"state","deviceId":…,"power"?:"on"|"off"|null,"climate"?:{…}|null}`（某台实时设备的变化，空调含室温，没说的键不是这次变化的内容）。Hub 只给看板推实时设备的变化：每台设备推 `state` 帧要求它用到的所有 HA 连接都已宣布为实时，所以一个连接的第一份快照不会逐台推，只在宣布之后以 `states` 整店帧发一次。客户端收到 `state` 帧就更新它指的那台设备，不再自己判断是否实时。客户端每 30 秒发一次 `ping`，Hub 的自动应答 `pong` 不会唤醒对象。
- 动作的响应**不再读回状态**：HA 返回 200 就是动作完成；事件驱动时新状态随后作为事件到来，无状态时没有状态可报。

#### 扫码页

- **无状态**：首屏接口不含设备状态。页面在拿到首屏后（不必等入场）立即取一次 `/session/device`，不阻塞选卡，设备名后面显示「正在获取电源状态」；取到关机就直接切到电源页。按下开机，HA 回 200 就放行进入下一页。空调的其它按钮实时发送，调温按钮在停下 1 秒后才发出一次请求（连按会重新计时），HA 回 200 就算完成，页面显示所选的值。除了 Bot 绑定（仍轮询）以外不轮询设备，也不保证页面实时。
- **事件驱动**：首屏接口直接带电源和空调。页面连上 `GET /api/v1/devices/session/ws?ticket=`（玩家登录态 + 设备二维码会话，WebSocket 升级）。帧：`{"type":"hello","watching":true|false,"power"?,"climate"?}`；`{"type":"watching","watching":…,"power"?,"climate"?}`（模式变化，变成事件驱动时附带当前状态）；`{"type":"state","power":"on"|"off"|null}` 或 `{"type":"state","climate":{…}|null}`（这台设备的变化，空调含室温）；`{"type":"refresh","reason":"binding"}`（页面显示的东西在别处变了，例如 Bot 刚确认了绑定，页面重新读一次状态）。按下开机后等这台设备的电源变成开再放行（15 秒没等到，按钮回来并提示；连接断开或设备不再被监听则直接放行）。机器被后台关掉时，玩家页同步切到开机页。空调同理：选择先显示，以推来的实际状态为准。Bot 绑定也走推送，不再轮询。
- 页面连接断开后不再相信它说过的，重新取一次状态；重连后以 `hello` 为准。旧版 App Clip 继续使用 `/session/state` 与 `/session/power`，两者保持可用。
- 麻将座位不是 Home Assistant 状态，仍按原来的方式轮询。

### 闲置自动关机

两条规则，**默认都关**，由店长在「设置 → 位置与设备 → 闲置自动关机」打开（`GET/PUT /api/v1/merchant/idle-power?shopId=`，存在 `app_settings` 的 `devices.idle_power`）：

- **店里没人**：没有任何进行中的场次满 N 分钟（默认 15），关掉所有开着的电源和所有在运行的空调。一段「没人」只执行一次；没人的起点取 Hub 记下的时间，没有就取最后一次结账时间。
- **单台设备闲置**：设备开着、没有人占用，并且不忙之后又过了「闲置判定时长」（`device.enabled` 打开；`device.minutes`，默认 10 分钟，全店一个值）。不忙的时刻是「最后一次经平台开机、延迟关机或操作 + 资源的占用时长」与「占用到期」中较晚的那个（麻将桌这类按座位判断占用的资源，占用时长按 0 计），见 [卡片、占用与查人](occupancy.md#闲置自动关机)。可以把设备设为「从不自动关机」（`PUT /idle-power/devices/:deviceId?shopId=`，`{ exclude }`）。店里没人且「店里没人」规则关着时直接关机；店里有人时按店长的选择：只标记为闲置、通过 Bot 提醒、或直接关机。

闲置和占用是同一件事：有人占用的设备不会被关，座位类的占用（麻将桌）一直算忙；占用怎么判断见 [卡片、占用与查人](occupancy.md#2-占用)。没有人占用时，经平台的开机、延迟关机和操作（`power.on`、`power.keep`、`coin`、`aime.scan`；关机不算）在占用时长内也让设备算忙，所以游客模式、实体投币的设备也能用「延迟关机」顶住。设备开机的时刻也算一次（事件驱动时用 HA 的 `last_changed`）。旧设置里大于 0 的默认闲置时长读作「单台设备闲置」已打开，并作为闲置判定时长。

**设备状态未知时规则照样执行**（连接是无状态模式，或 HA 报告不可用）：自动关机不依赖设备的实际状态。「店里没人」规则对每台没有明确关着的设备都下发关机，空调同理，往已经关着的设备再发一次关机没有害处。「单台设备闲置」规则没有开机时刻，只能以设备自己的最近活动为时钟：没有任何活动就没有起点，不处理；超时后关一次，之后只要它在上次关机之后没有新的活动就不再重复，因为没有状态能证明那次关机生效了。已知状态只来自事件驱动的连接，无状态连接上存着的旧值不会被采信。

**执行**由店铺 Hub 负责：只记最后活动时间，不逐秒倒数；alarm 设在最早的截止时间。刷卡信号、扫码操作、刷卡登录、店铺接口的任何写操作（入场、结账等）和设置保存都会「碰一下」Hub，2 秒内的多次合并成一次检查。检查时从 D1 读设置、进行中的场次、事件驱动连接上设备的电源与空调状态和最近 24 小时的活动，交给 `planIdle` 决定，然后以**系统身份**（`{type:"system"}`）执行 `power.off` / `climate.off`——不算任何人的活动，也不刷新自己的倒计时。自动关机失败的设备 10 分钟内不再重试。关掉的若是正在监听 Home Assistant 的那台机台，Hub 同时把它标为下线并补位。闲置标记是电源能力的平台状态 `idle`（`true`/`false`），变化记 `change` 事件，设备日志显示「已闲置 / 恢复使用」。

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
