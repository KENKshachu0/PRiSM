# PRiSM Server Routes (`packages/server/src/routes`)

本目录包含 `@prism/server` 的路由层实现，分为平台级路由（Platform Routes）、系统级路由（System Routes）、多租户店铺级业务路由（Shop Routes）以及静态资源处理路由（Web Assets）。

## 目录结构

```
routes/
├── index.ts                # 导出所有路由及相关类型
├── platform/               # 平台级与用户级路由
│   ├── auth.ts             # 登录、注册、退出与会话管理 (/api/v1/auth)
│   ├── passkeys.ts         # WebAuthn Passkey 挑战生成、校验与设备管理
│   ├── user.ts             # 当前用户信息、多身份绑定与账号 Passkey 管理
│   └── shops.ts            # 店铺创建、查询、更新、封面与删除管理
├── shops/                  # 多租户单店业务路由 (/api/v1/shops/:shopCode)
│   ├── index.ts            # 组合 shopRouter、tenantMiddleware 与店铺设置/概览接口
│   ├── player.ts           # 玩家计费会话、检出结算、订单与历史 (/player)
│   ├── staff.ts            # 店员管理、流水查询、玩家资产与报表 (/staff)
│   ├── integration.ts      # Bot 与外部系统集成接口 (/integration)
│   ├── cashier.ts          # 前台刷卡登记、到店入场与外部收银结算 (/cashier)
│   ├── pricing.ts          # 计费规则管理与时间线费率预测 (/pricing)
│   ├── assets.ts           # 资产定义与计费抵扣效果配置 (/assets)
│   ├── redeem.ts           # 礼品发放与兑换码核销 (/redeem)
│   └── views.ts            # 统一响应视图对象映射器 (View DTOs)
├── system/                 # 系统级路由
│   ├── health.ts           # 健康检查接口 (/health, /api/v1/health)
│   └── version.ts          # 版本与修订号接口 (/version, /api/v1/version)
└── web-assets.ts           # SPA 静态前端资源分发与回退路由
```

## 多租户架构与依赖注入（Direct DI）

多租户店铺业务路由（`shopRouter`）直接挂载于 `/api/v1/shops/:shopCode`。其核心设计原则为：

1. **彻底消除虚拟 HTTP Forward**：拒绝通过二次创建合成 `Request` 并调用 `createPrismApp(deps).fetch()`，所有请求由原生 Hono 嵌套路由分发。
2. **`tenantMiddleware` 依赖注入**：
   - 从路由参数 `:shopCode` 解析店铺（支持 UUID 或 8 位公开标识 `public_id`）；
   - 从数据库装配该店铺独享的 `@prism/application` 依赖容器（D1/SQLite Repositories、排他锁服务、硬件驱动解析器、本地时区转换等）；
   - 注入 `c.set("shop", shop)` 和 `c.set("deps", deps)`，下游子路由通过 `getShop(c)` 与 `getShopDeps(c)` 直接消费领域服务。
3. **统一领域错误映射**：集中捕获 `PrismDomainError`，映射为标准的 HTTP 400/404/409 状态码与统一 JSON 结构。

---

## 路由规范

### 1. 多租户店铺级业务路由 (`/api/v1/shops/:shopCode`)

#### 1.1 玩家端路由 (`/player`)
- `GET /me`: 获取玩家个人信息、当前活跃会话状态及钱包余额。
- `GET /assets`: 查询玩家拥有的资产持有（Holdings）与流水账本。
- `GET /checkouts/history`: 分页查询历史结算账单。
- `GET /checkouts/:checkoutId`: 获取指定单笔结算收据明细。
- `GET /checkout/latest`: 获取最新一笔结算收据。
- `GET /sessions/history`: 查询玩家入场会话历史记录。
- `GET /sessions/:sessionId/history`: 查询指定历史会话详细时间线与扣费明细。
- `POST /session/start`: 发起入场会话（支持自定义入场费率规则标签）。
- `POST /sessions/:sessionId/stop`: 结束会话但暂不结算（待收银台或后续统一结算）。
- `POST /checkout/preview`: 预计算当前待结会话的结算账单、资产抵扣与时间线费率。
- `POST /checkout/confirm`: 确认结算，扣减钱包资产，完成出场结账。
- `POST /redeem`: 兑换礼物兑换码。
- `POST /device-commands`: 玩家发起关联设备控制指令（投币、刷卡等）。
- `POST /business-items/:businessItemId/purchase`: 购买商户上架的业务增值服务。
- `GET /business-item-orders`: 查询玩家业务商品购买订单列表。

#### 1.2 店员管理路由 (`/staff`)
- `GET /players`: 查询店铺内的注册玩家列表。
- `POST /players`: 创建或录入新玩家。
- `PATCH /players/:playerId/status`: 变更玩家状态（启用/禁用）。
- `GET /players/:playerId/assets`: 查看指定玩家的资产与账本。
- `POST /players/:playerId/assets/grants`: 店员向玩家发放/赠送指定资产。
- `POST /players/:playerId/assets/adjustments`: 店员调整玩家的资产持有量。
- `POST /players/:playerId/wallet/adjustment`: 店员快捷调整玩家的充值钱包余额。
- `POST /players/:playerId/identities`: 为玩家绑定外部账号身份。
- `DELETE /players/:playerId/identities/:provider/:subject`: 解绑玩家外部身份。
- `GET /sessions/active`: 查看全店当前活跃会话列表。
- `POST /sessions/start`: 店员为指定玩家开启入场会话。
- `POST /sessions/:sessionId/stop`: 店员强制终止指定会话。
- `POST /checkout/preview`: 店员预计算指定玩家待结账单。
- `POST /checkout/confirm`: 店员代为发起结算。
- `POST /checkout/override`: 店员权限人工调整金额并结算。
- `GET /reports/summary`: 查询指定时段营收报表汇总（营业额、人次、赠送总额）。
- `GET /reports/settlements`: 查询结算流水明细报表。
- `GET /reports/checkouts`: 查询出场结算订单报表。
- `GET /reports/players`: 查询玩家消费频次与累计支出统计。

#### 1.3 前台收银路由 (`/cashier`)
- `POST /lookup`: 快速读取实体卡并检索收银卡片档案（支持 Type-A / FeliCa）。
- `GET /profiles/:playerId`: 根据玩家 ID 获取前台收银档案及待结会话。
- `POST /register`: 为未绑定实体卡的顾客登记开卡并创建临时/正式玩家档案。
- `POST /profiles/:playerId/entry`: 实体卡刷卡到店开台入场。
- `POST /profiles/:playerId/checkout/preview`: 刷卡离场前台预结预览。
- `POST /profiles/:playerId/checkout/confirm`: 外部渠道（微信、支付宝、现金）结账确认，结清离店。

#### 1.4 集成与机器人路由 (`/integration`)
- 需持有店铺 `api_tokens` 发行的 `integration` 角色 Bearer Token。
- `POST /players/by-identity/resolve`: 根据第三方身份解析关联玩家。
- `POST /players/by-identity/register`: 自动注册或获取第三方身份玩家。
- `POST /players/by-identity/session/start`: 机器人代发起入场。
- `POST /players/by-identity/sessions/:sessionId/stop`: 机器人代停止会话。
- `POST /players/by-identity/checkout/preview`: 预计算第三方身份账单。
- `POST /players/by-identity/checkout/confirm`: 确认结算第三方身份账单。
- `POST /players/by-identity/wallet`: 查询指定外部身份玩家的钱包余额。
- `POST /players/by-identity/assets`: 查询指定外部身份玩家的资产明细。
- `POST /players/by-identity/redeem`: 机器人代为核销兑换码。
- `POST /players/by-identity/history`: 查询历史消费会话记录。
- `GET /device-states`（别名 `/devices/states`）: 实时读取店内绑定电源的设备的电源状态。

#### 1.5 设备
店铺级没有单独的设备路由。设备的增删改与日志在 `platform/merchant-machines.ts`（`/api/v1/merchant/machines`），员工与 Bot 的设备动作分别是 `/staff/device-actions` 与 `/integration/players/by-identity/device-actions`，玩家通过设备二维码页操作。设备模型见 `packages/server/src/devices` 与 `docs/integrations-and-machines.md`。

#### 1.6 计费配置与资产规则 (`/pricing`, `/assets`, `/redeem`)
- `/pricing`: 计费规则 CRUD、状态启停、费率时间线（Timeline）预演及规则版本归档。
- `/assets`: 资产定义（货币、时段优惠券、次数券）CRUD 与计费关联抵扣效果（Pricing Effects）配置。
- `/redeem`: 店铺礼品配置、批量兑换码生成、兑换记录查询与作废（Revoke）。

---

### 2. 平台认证路由 (`/api/v1/auth`)

- `POST /register`: 用户注册，创建本地认证身份并建立会话 Cookie。
- `POST /login`: 用户登录，校验账号状态并建立会话 Cookie。
- `POST /logout`: 退出登录，注销当前会话并清除 Cookie。
- `GET /me`: 获取当前登录用户基础状态。
- 子路由 `/passkey`:
  - `GET /options`: 获取 WebAuthn 认证挑战参数（含防刷频限流）。
  - `POST /`: 校验 Passkey 认证结果并建立用户会话。
  - `GET /register/options`: 获取 WebAuthn 凭证注册挑战（需登录）。
  - `POST /register`: 校验并保存新 Passkey 凭证（需登录）。

### 3. 平台用户与账号路由 (`/api/v1/user`, `/api/v1`)

- `GET /me` / `GET /`: 获取当前用户资料及商户店铺归属标识 (`hasShops`)。
- `GET /account`: 获取用户绑定的所有外部第三方身份（如 MuNET）与已登记 Passkey 列表。
- `DELETE /account/passkeys/:id` / `DELETE /passkeys/:id`: 注销指定 Passkey 凭证。
- `PATCH /account/passkeys/:id` / `PATCH /passkeys/:id`: 重命名 Passkey 设备备注名。

### 4. 平台商户店铺路由 (`/api/v1/shops`, `/api/v1/merchant/shops`)

- `GET /`: 获取当前用户有权管理的店铺列表（管理员可查看全量店铺）。
- `POST /`: 新建店铺。支持设置经纬度、地理围栏半径、时区自动判定（`resolveLocationTimeZone`）、初始账务配置（`billingSetup`）及 Bot 对接 Token。
- `GET /:id`: 根据店铺 UUID 或 8 位公开标识 `public_id` 查询店铺公开属性。
- `GET /:publicId/hero`: 获取店铺封面图二进制数据，支持基于 `ETag` 和 `If-None-Match` 的 304 强缓存。
- `PATCH /:id`: 修改店铺名称、定位坐标、围栏半径及封面（仅所有者或管理员可用）。
- `DELETE /:id`: 删除店铺。具有业务流水或玩家记录的店铺禁止删除（返回 409 `SHOP_HAS_HISTORY`）。

### 5. 系统运行状态路由

- `/health` / `/api/v1/health`: 返回系统健康状态 (`ok: true`, `service: "prism-api"`), 部署阶段包含 `x-prism-revision` 标头。
- `/version` / `/api/v1/version`: 返回服务版本号、部署修订号及运行时依赖版本信息。

### 6. 静态资源路由 (`web-assets.ts`)

- 通过 `serveWebAssets` 中间件与 `webAssetsRouter` 路由分发 Cloudflare `ASSETS` 静态页面与构建产物。
- 自动避开所有 `/api/`、`/.well-known/`、`/callback` 等动态服务路径。
- 在维护阶段（`PRISM_DEPLOY_PHASE === 'maintenance'`）自动拦截。
- 支持针对 HTML 页面请求回退至 SPA 根入口 (`/`)。
