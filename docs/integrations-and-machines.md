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
    "provider": "qq",
    "subject": "123456"
  }
}
```

也可以使用迁移兼容简写：

```json
{
  "identityKey": "QQ:123456"
}
```

`provider` 会统一转成小写，`subject` 只去掉首尾空白。简写只按第一个冒号分隔，所以 `telegram:abc:def` 会解析为 provider `telegram`、subject `abc:def`。

### 常用玩家动作

### 在场客流与设备状态

机器人对自己投资的入口可以读取「在场玩家」和店内设备上报：

| 路由 | 用途 |
| --- | --- |
| `GET /rpc/integration/sessions/active` | 列出在场所有活跃 session，含 `playerDisplayName`、`identities` (provider+subject)、`startedAt`、`label`、`elapsedMinutes`。机器人在 `/list`、`/窝里` 这类命令里用 `identities` 中的 `subject`（QQ 号）去调用聊天平台 API 拉昵称，而不是直接显示后台存的 `playerDisplayName`。 |
| `GET /rpc/integration/device-states` | 列出当前所有设备的最新电源/状态。`state` 为普通字符串（如 `on`、`off`），bot 的 `/show` 命令直接消费。 |

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

示例：QQ 用户第一次发送 `/入场`，不存在就自动注册，并进入标准音游计费：

```bash
curl -X POST https://prism.example.com/rpc/integration/players/by-identity/session/start \
  -H "Authorization: Bearer <integration-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "identityKey": "QQ:123456",
    "autoRegister": true,
    "displayName": "QQ 123456",
    "pricingConfigIds": ["music-standard"],
    "label": "音游区间"
  }'
```

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
    identity: { provider: "qq", subject: "123456" },
    autoRegister: true,
    displayName: "QQ 123456",
    pricingConfigIds: ["music-standard"],
    label: "音游区间",
  }),
});
```

玩家命令需要操作机器或设施时，也继续使用 Integration Token。后端会先按 QQ 号解析玩家，再检查该玩家是否已入场、投币冷却是否满足，最后生成发给机器通道或设施执行器的指令：

Aime 扫卡可以走便利方法：

```ts
await client.requestScanByIdentity(
  {
    provider: "qq",
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

## 2. Machine：机器软件与设备控制

Machine 适合店内机器软件、投币控制器、Aime 桥接程序、门禁/电源/空调控制桥接程序。Machine Token 不代表玩家，只代表一套可信机器接入程序。

**Token 要求：**

- 在 Staff Web「员工与系统」中创建「机器软件接入」密钥。
- 请求 Header 使用 `Authorization: Bearer <machine-token>`。

新机器软件应优先连接 `GET /rpc/machine/ws`，使用 `Authorization: Bearer <machine-token>`。连接后先发送：

```json
{
  "type": "hello",
  "machineId": "maimai-dx-1",
  "capabilities": ["coin", "aime.scan"]
}
```

服务端会回复 `hello.ack` 并推送该机器的待执行命令。机器执行后发送 `ack`，`status` 为 `success` 或 `failed`。失败 ACK 的 `message` 会保存到命令记录里，方便后台排查机器故障。

设备动作统一使用明确类型和目标分类：`door.open`、`power.on`、`power.off`、`ac.set_temperature` 属于 `facility`，执行方向是 `home_assistant`、`ttlock` 或设施网关；`coin` 和 `aime.scan` 属于 `game_machine`。原生 PRiSM 机器软件仍可走 `machine_ws`；Hinata IO 客户端走 `hinata_io` 直接执行器，由后端调用 relay HTTP 端点。Home Assistant 电源/空调控制与 TTLock 门锁控制保持独立边界。

### TTLock 配置与门禁控制

TTLock 由员工在设备看板的设施设备区域点击锁形设置按钮配置，保存于 `app_settings` 的 `devices.ttlock_connection` 和 `devices.ttlock`。配置更新后，后端会在执行命令和同步状态时动态读取，不需要 Worker 环境变量或重新部署。连接配置兼容旧 `prism-neo` 的字段：

```json
{
  "baseUrl": "https://api.sciener.com",
  "clientId": "app-id",
  "clientSecret": "app-secret",
  "appAccount": "ttlock-app-account",
  "appPwd": "ttlock-app-password",
  "accessToken": "access-token",
  "refreshToken": "refresh-token",
  "accessTokenExpiresAt": null
}
```

门锁映射格式为 `[{ "id": "front-door", "name": "主门锁", "aliases": ["front-door", "门禁"], "lockId": 25356943 }]`。玩家或员工只需使用 `name` / `aliases` 作为 `target.ref`；匹配到 TTLock 映射的 `door.open` 会保存为 `executorKind: "ttlock"`，调用 `/v3/keyboardPwd/add` 创建一个 8 位随机临时密码，默认有效期 3 分钟。看板会定期调用 `/v3/lock/queryOpenState` 展示锁定/解锁状态。access token 过期时，运行时会优先使用 `refreshToken`，失败后再使用 TTLock APP 账号密码重新获取 token，并把新 token 写回数据库。

### Hinata IO 配置与协议

Hinata IO 设备由员工在设备看板的游戏机器区域配置，保存于 `app_settings` 的 `devices.hinata_io`。配置更新后，后端解析设备和执行命令时会读取最新设置，无需修改环境变量或重新部署。每项数据格式如下：

```json
[
  {
    "id": "maimai-left",
    "name": "舞萌 DX 左机",
    "aliases": ["舞萌左机", "mai-left"],
    "url": "https://relay.example/instance-id",
    "password": "remotePassword",
    "salt": "ABEiM0RVZneImaq7zN3u_w",
    "coinKey": 32,
    "cardType": "aime"
  }
]
```

`id` 仅用于后端持久化与审计，玩家输入不会与它匹配；玩家只能使用 `name` 或 `aliases`。所有设备的 `id` 必须唯一；忽略大小写和首尾空白后，`name` 与 `aliases` 也必须全局唯一，冲突配置会被拒绝。`url` 是 Hinata IO relay 的实例状态端点。`password` 必须与客户端远程密码一致；`salt` 是 16 字节随机值的无 padding base64url 表示；`coinKey` 默认 `32`（空格键），范围为 `0..65535`；`cardType` 默认 `aime`。

后端按 Hinata IO 协议使用 PBKDF2-HMAC-SHA256（600000 次）和 AES-256-GCM 生成 `E2EE_V1`：投币向 `<url>/event` 发送有效期 30 秒、带 UUID 去重 ID 的 `KEY_PRESS`；刷卡向 `<url>` 发送可重放状态通道中的一次性 `SET_CARD`。relay 返回 404 时命令记为执行失败，bot 只显示“设备未连接”，详细错误保留在后端设备命令审计中。刷卡卡号只在一次命令执行期间存在于内存中，持久化命令前会从 payload 中移除。

### 玩家面对的设备别名与 Home Assistant 解析

玩家通过机器人指令（如 `/prism on wacca` 或 `/prism lock`）发起设施动作时，插件把用户输入作为 `target.ref` 设备引用发送。用户只能输入后台配置的设备 `name`、任意一个 `alias`（别名）或 `all`，不能直接输入 Home Assistant entity ID 或 TTLock `lockId`，后端也不接受设施请求中的 `target.id`。`door.open` 会先读取 `devices.ttlock`，其他设施动作读取 `devices.homeassistant`，因此门锁与电源可以使用相同的设备引用体系而不会串用执行器。

1. 匹配设备 `name`；
2. 匹配设备 `alias` 列表中的任一条目；

`alias` 必须配置为字符串数组；单个字符串不是有效格式，设置接口会拒绝保存。匹配大小写不敏感并去除首尾空白。解析成功后，Home Assistant 命令的 `DeviceCommand.deviceId` 保存真实 entity ID，TTLock 命令的 `DeviceCommand.deviceId` 保存后台映射的内部 `id`；执行器不再解析 name、alias 或原始用户输入。`all` 被表示为没有单一 `deviceId` 的设施批量目标，持久化为 `device_id = NULL`；它只支持 `power.on/off`。普通设备和批量动作分别在 `action.payload.deviceLabel` 中返回设备 `name` 和“所有设备”。批量失败信息同样使用设备 `name`，不会暴露 entity ID。未命中的 name/alias（包括用户直接输入的 entity ID 或 TTLock lockId）统一返回「设备不存在」。

> 需注意：设备状态同步（`syncHomeAssistantStates`）始终使用注册表里的真实 `id` 调用 `/api/states/<entity_id>`，因此看板上的在线/离线状态不会被别名影响；只有命令执行路径此前漏掉了这一解析，现已修复。

Cloudflare Workers 运行时通过保持原生 `fetch` 调用上下文的包装函数访问 Home Assistant，避免把运行时函数作为普通对象方法调用而触发 `Illegal invocation`。
