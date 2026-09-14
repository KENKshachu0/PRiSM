# PRiSM Next 系统架构设计

## 设计方向

PRiSM Next 是一款单店、可自托管的场馆运营核心系统。系统支持将 Cloudflare 部署与本地化部署作为一等公民，但领域模型必须保持纯粹，不依赖于任何特定的运行环境。

## 模块与包边界

- `packages/core`：纯粹的 TypeScript 领域逻辑。禁止在此引入 Hono、数据库客户端、Cloudflare 绑定、Koishi API、文件系统访问或网络请求。
  - `assets`：资产定义、计费效果、资产持有量、合并赠送策略、资产账本流水。
  - `session`：活跃/已关闭场次的生命周期。
  - `settlement`：费用项收集、资产效果调整、货币扣减和结算输出。
  - `pricing-config`：持久化计费配置模型、基本校验以及配置到计费提供商的构建器。
  - `pricing-time`：默认时间计费和优先级时间计费规则。
  - `redeem`：礼物兑换规则与礼物赠送。
  - `device-command`：设备动作授权、设施/游戏机器目标分类、执行器选择、投币冷却、响应确认（ACK）和过期状态流转。
  - `storage-ports`：场次、资产、兑换记录、结算、设备命令、玩家和计费配置的仓储契约（Repository Ports）。
- `packages/storage-sql`：兼容 SQLite/D1 的 DDL、写仓储和 SQL 读模型。需要聚合多张表的列表由这里用单条关联查询完成，再调用 core 的统一领域判断；运行时适配器仅提供 SQL 执行器。
- `packages/adapter-sqlite`：本地部署下的 Bun SQLite 执行器包装。
- `packages/adapter-d1`：Cloudflare Worker 部署下的 D1 执行器包装。
- `packages/server-hono`：Hono 路由应用工厂和强类型 RPC/API 层。只负责鉴权、参数解析、调用应用服务和映射视图模型，不直接执行 SQL，也不承载玩家批量结账、实时聚合或 Home Assistant 同步等业务流程。
- 运输层依赖必须由 runtime 显式装配；Hono 不再自行构造员工现场操作服务或补齐缺失的业务依赖。
- `packages/application`：用例编排与跨适配器契约层。结合核心领域规则与仓储端口编排结算、员工现场操作、设备状态同步和统一资产效果；查询 DTO 与插件目录契约也定义在这里，避免内层依赖 Hono。`available-assets` 和 SQL 读模型都必须调用 core 的 `evaluateAssetHoldingAvailability`，不得重复实现可用性判断。
- `packages/runtime`：部署装配中心。为 Cloudflare D1/Worker 和 SQLite/本地 Bun 部署组装仓储、SQL 读模型、应用服务、数据库鉴权适配器、外部设备适配器、运行时插件和默认计费规则；不直接包含 SQL 或重复领域规则。生产鉴权只接受数据库中的管理员会话、玩家会话和 API Token，不提供静态令牌回退。
- `packages/prism-dashboard`：新的 Flutter Web 后台，Dart 包名为 `prism_dashboard`。它以玩家现场运营为中心，直接调用员工 HTTP API 与读模型，不在旧 `admin-flutter` 上继续叠加 UI。设备连接和映射只在设备看板维护；员工与系统页负责店铺、注册、员工和接入密钥设置。
- Staff Web 时间显示统一通过 `packages/prism-dashboard/lib/src/shared/time_format.dart` 处理，并由 `admin_time_zone.dart` 使用 `store.timeZone` 做 UTC/店铺时间转换。带日期的业务时间统一显示为 `YYYY-MM-DD HH:mm`，日期范围使用 `YYYY-MM-DD`，只有纯时钟控件、计费时间轴刻度和营业时段才使用 `HH:mm`。报表日期边界也按店铺时区生成，不依赖浏览器所在机器时区。
- Staff Web 的权限门控与后端角色一致：viewer 保留查询、筛选、刷新、复制和审计详情能力，但现场结账、玩家修改、资产/计费配置和设备命令等写入口不可用；manager/owner 可以执行普通业务写入，员工账号与接入密钥管理仅 owner 可用，其他角色不会请求对应 owner-only 接口。退出登录会撤销持久化管理员会话，不只清理浏览器本地 Token。
- `packages/koishi-plugin`（git 子模块，独立仓库 `koishi-plugin-prism`）：直接调用 Integration HTTP API 的 Koishi 机器人插件。

## 接入身份模型

当前持久化 API Token 只分为两类：

- `integration`：机器人、Koishi/AstrBot 或店内自有入口服务使用。它代表受信任的店内入口，后续通过结构化外部身份（如 `provider=qq, subject=123456`）发起玩家相关动作。
- `machine`：游戏机软件或可控制游戏机的小主机使用。它代表机器软件接入，只通过 `/rpc/machine/ws` 接收实时命令、确认执行结果并发送心跳。

员工后台不再创建 `player`、`bot` 或 `agent` API Token。玩家 Web 入口使用绑定到单个玩家的 player session；机器侧也使用 `machine` 语言，避免把 Home Assistant 设施控制和游戏机软件能力混在一个「Agent」概念里。

玩家 Web 入口使用 `POST /rpc/player-auth/login/by-identity` 创建 `player_sessions`。会话记录只保存 token hash、玩家 ID、过期时间、最后使用时间和撤销时间；浏览器随后调用 `/rpc/player/*` 时只发送玩家会话 Token。后端从 token hash 查出唯一玩家，不接受浏览器提供的 `X-PRiSM-Player-Id` 来切换身份。机器人、自助入口和店内外部服务如果需要按 QQ 或 Aime 身份操作玩家，仍应使用 `integration` API 和结构化外部身份，而不是借用玩家会话。

## 核心原则

**插件只能提议领域事实，不能直接修改状态。**

当前实现：

- 计费插件返回 `ChargeItem[]`。
- 核心结算系统汇总费用项。
- 核心结算系统扣减货币类的 `AssetHolding` 记录。
- 核心结算系统输出 `AssetLedgerEntry[]`。

通过这种设计，时间计费、套餐计费、人工费用、优惠券、月卡以及未来非时间类的商品，都能统一通过一套资产持有与资产账本系统进行集成结算。统一结账响应同时提供 `checkoutAdjustments` 和 `pricingCapAdjustments`：前者表示不属于单一 session 的整单优惠或人工调整，后者表示全局封顶的计价结果；兼容用的 `adjustments` 仍保留合集。展示层不得把两类调整附着到结账锚点 session，也不得把方案内封顶或全局封顶称为优惠。

## 资产模型

- `PricingEffect`：可复用的资产结算效果，如月卡免时费、固定抵扣券、按比例折扣券。它有自己的生效时间、过期时间、归档状态和可选扩展配置。资产定义通过 `pricingEffectId` 绑定它，而不是把正式结算规则写进资产定义 JSON。扩展配置可限定适用计时名称、计费方案和具体计费规则，使单个玩家的多条平级计时能各自套用正确的优惠或加减价。
- `AssetDefinition`：店铺管理的资产目录项。包含类型（`type`）、代号（`code`）、显示名称、是否可堆叠、可选计费效果绑定，以及资产定义自身的生效/过期时间。
- `AssetHolding`：玩家当前持有的资产。包含数量（`quantity`）及可选的激活时间/过期时间。这是快速查询用的当前状态投影，而非审计源。
- `AssetTransaction`：单次业务行为导致的资产交易，如场次结算、CDK 兑换、注册赠送或员工调整。包含唯一 ID、交易类型、业务引用、创建时间及元数据。

玩家可见或可消费的当前资产统一使用 `evaluateAssetHoldingAvailability` 解析。只有数量为正、持有记录已生效且未过期、关联资产定义存在且未归档、资产定义已生效且未过期的记录才属于可用资产（「数量为正」按 `money.ts` 的 `isPositiveQuantity` 判定，浮点残渣不算余额）；面向玩家的读取还会排除资产定义元数据中 `hiddenFromPlayer: true` 的项目。应用层的 `AvailableAssetReader` 用于结算、兑换和购买等已取得持有快照的流程；玩家摘要、员工玩家列表的钱包余额与资产列表由 `storage-sql` 用单条关联 SQL 同时读取持有和定义，再调用同一 evaluator。玩家钱包、资产接口和兑换回执默认只返回玩家可见资产；结算、人工扣款和服务项目购买会显式请求内部可用资产，以便隐藏的后台计费资产仍能按定义参与结算。结账响应不再让客户端从资产列表推导余额，而是直接返回 `wallet.balanceBefore` 和 `wallet.balanceAfter`；两个值都是经过相同可用性规则后的结算余额，余额为 `0` 也会返回。员工资产审计和历史流水保留原始记录，以免归档或过期后丢失历史；当前 holdings 会附加可用状态和不可用原因，dashboard 默认显示可用记录并允许切换到无效或全部。所有读取均无副作用，不会顺便清理持有记录。
- `AssetLedgerEntry`：追加式资产变更明细记录，包含增量（`delta`）、变更原因、引用 ID 以及可选的 `transactionId`。
- `PlayerIdentity`：玩家的外部身份绑定。以 provider（如 QQ、Aime 卡）加 subject 唯一键标识，用于第三方登录与遗留数据映射。
- `PlayerSession`：玩家 Web 或自助前台登录后的短期会话。它绑定单个 `playerId`，只存储 token hash，不作为店内机器人或机器软件的长期接入凭证。
- `BusinessItem`：店铺管理的服务项目（如赛事报名、预约占位、包间套餐、服务费）。包含类别、显示名称、价格、可选关联资产、激活/过期时间以及归档状态。
- `BusinessItemOrder`：玩家购买 `BusinessItem` 的履约记录。记录订单价格、状态（已支付/已履约/已取消）、关联的会话及生成 `kind=business-item.purchase` 的资产交易。

系统不单独设立“钱包账户”模型，货币只是一种特殊的资产类型（`type=currency`）。系统内建的账户本位币为 `(type=currency, code=paid)`（充值余额）和 `(type=currency, code=free)`（赠送余额）。OOBE 创建向导会首先初始化这两个资产；商家可以更改其显示文本（如“游戏点数”、“余额”），但底层关联键值保持不变。

金额、余额和资产数量都按 decimal-capable `number` 处理，不要求必须是整数。SQLite/D1 schema 中的资产持有量、资产流水增量、结算金额、费用细项、计费历史、计费效果金额和服务项目价格均使用 `REAL` 列声明；API 层接收 JSON number，Staff Web 的金额输入支持小数。时间长度、次数上限、使用次数、优先级等仍保持整数语义。

因为 `REAL` 是二进制浮点，金额和数量**必须**通过 `packages/core/src/money.ts` 的统一入口比较与量化，不能直接写 `quantity > 0`、`amount === 0` 或 `available < amount`。入参在 API 和 application 边界量化到分，使存储里的值规范化。完整规则、已量化的边界、已知残留风险和后续收敛路径见 [money.md](money.md)。

所有资产定义、计费效果、礼物、商品项目及计费配置均采用**归档语义**，不作物理删除。归档可防止历史账单与审计引用失效。系统在写路径中会拒绝授予已归档或不在有效期内的资产定义、拒绝使用已归档资产创建/兑换礼物以及解析已归档配置，但支持在后台进行还原操作。计费配置内已保存的时间规则也按归档处理：员工移除它时会把规则状态改为 `archived`，结算和时间轴会忽略它，但配置 JSON 仍保留规则 ID、价格和日期范围，便于历史账单的 `pricing_history_entries.rule_id` 回查；未保存的草稿时间规则才会物理移除。导入的提供商有效负载可能仍包含退役的时间规则行，以供迁移上下文使用；结算报价、启用配置验证和时间轴渲染会忽略这些退役行。固定收费方案使用 `charge.fixed` 提供商，只参与一次性费用计算，不进入营业时间轴。

新版资产系统不再使用旧版的资产变更日志形状，采用：

- 资产当前持有表（`asset_holdings`），供前端快速读取。
- 不可变的资产交易表（`asset_transactions`），记录单一业务动作。
- 追加式的流水账本表（`asset_ledger_entries`），详细记录每个资产在交易下的具体 delta。

每个资产写入先在 core 中比较变更前后的 holdings，得到只包含新增/变更记录的 `upserts` 和仅包含被移除 ID 的 `deleteIds`。`AssetRepository.commitAssetTransaction()` 将这些差异、`asset_transactions` 和 `asset_ledger_entries` 作为同一个原子单元提交：SQLite 使用数据库事务，D1 使用批处理事务。它不会按 `player_id` 删除后重建整份资产列表，因此一次结账、兑换或人工调整只触及实际变化的 holding，同时保留完整交易和流水审计。

这在保留完整审计能力的同时，避免了核心资产操作与遗留数据库行怪癖的深耦合。

## SQL 调用与批处理约束

- 一个 API 读模型能够由同一数据库快照表达时，优先使用单条 `JOIN`、CTE 或带行类型的 `UNION ALL`。玩家摘要、玩家/员工资产、玩家与身份列表、活动场次与身份、会话详情、结算详情及报表汇总都有查询次数测试，正常调用只执行一条 SQL。
- 当前持有与历史流水虽然来自不同表，但资产接口通过一条带 `row_kind` 的 `UNION ALL` 返回；运行时在 TypeScript 中按行类型还原结果，不再先执行旧 holdings 查询后丢弃其结果。
- 同表的重复写入使用多行 `VALUES`。为兼容 SQLite 与 D1，每条动态语句最多绑定 100 个参数，数据超过上限时才分块；资产流水、计费历史、兑换码和迁移导入均遵循此规则。
- 跨表写入不会为了表面上的“一条 SQL”破坏数据边界。一次资产业务会把差异 holding、交易和流水放入一个原子批处理；结算账单仍需分别保存概要、费用项和调整项。此类流程按表批量执行，不再按记录 N 次执行；当前 holdings 不允许按玩家整表删除后重建。
- Home Assistant 状态同步要求仓储提供批量保存；统一结账要求仓储同时保存 `player_checkouts` 与关联 session 结算，不会回退为只写单个 session 结算。
- 资产账本、结算明细和计费历史仍保留原有审计记录与顺序；SQL 精简不能删除流水、改变有效期边界或把读请求变成清理数据的写请求。

## 已实现的业务切片

通过 `settleSession()` 串联的业务链路：

1. 将场次数据传递给计费提供商。
2. 计费提供商返回具体的费用项。
3. 核心结算按“赠送余额优先于充值余额”的顺序进行扣减。
4. 返回结算结果、资产账本明细、费用细项以及更新后的持有量缓存。
5. 计费提供商只能读取资产快照，禁止擅自修改核心账户状态。

已实现的辅助业务切片：

- 场次启动/结束生命周期。同一玩家可同时拥有多个平级 active session；这些 session 不区分主次，现场页按玩家聚合展示，最终由玩家级统一结算处理未结 session。Integration 创建的 session 会带有来源 metadata，Integration 只能停止自己创建且属于当前外部身份玩家的 session，停止后仍保持未结算状态。
- 新玩家注册统一经过 Staff Player 应用服务；当 `player.registration.defaultPresentId` 指向有效礼物时，按礼物中当前有效的 grants 生成一次 `player.register.present` 资产交易。默认礼物未配置、已归档、过期或不存在时只跳过发放，不阻断玩家注册。
- 优先级计费引擎：支持星期、指定日期、绝对日期范围、跨天区间（按开始日匹配）、时间舍入单位、宽限期、方案内封顶、跨场次历史计费封顶，以及用于叠加抵扣 session 的负数单价规则。支持设备操作与首次宽限联动（操作设备即产生费用）：若玩家在计费场次内触发了除门禁 `door.open` 外的有效设备动作（如 `coin` 投币、`aime.scan` 刷卡、`power.on`/`power.off` 电源开关、空调等），该场次自动标记为已操作设备（`metadata.deviceOperated: true`，结算时亦可通过命令流水回溯补齐），并立即使首次进店免单宽限失效，收取至少 1 个计费单位基础费用（即使即时登出或游玩不足 1 分钟；后续尾数取整宽限保留不受影响）；未操作任何设备的玩家在宽限期内离场依然享受免费离场。每个 session 保留原始正负计费贡献，只在玩家级统一结账完成全部 session 汇总后将最终应付金额限制为不低于 `0`。每次统一结账会写入一条 `player_checkouts`，并以 `settlements.checkout_id` 关联其中全部 session；营业报表直接汇总这个持久化批次，不再用相同时间戳猜测哪些 session 属于同一单。全局封顶时间轴使用同一套时间匹配规则，但不产生费用项；它在资产和手动改单等后置优惠之前，对选中的按时计费方案合计做二次封顶，并把历史写入 `pricing_cap_history_entries`。员工展示按该规则锚定的封顶窗口聚合历史和本次参与金额；达到上限时显示封顶后的最终金额，而不是本次封顶调整的差额。
- `0013_player_checkouts.sql` 是报表读模型的必需迁移：它为历史 settlements 建立统一 checkout 并补齐 `checkout_id`，因此运行时报表不保留旧的按玩家和相同结算时间猜测批次的分支。
- 礼物兑换校验及资产堆叠/延期/替换授予逻辑。兑换码过期或礼物过期会拒绝兑换；兑换码和礼物都有效时，礼物中未生效或已过期的内容会被跳过，不会到账。
- 设备动作授权、投币冷却、执行与审计状态流转。设施动作使用 `facility/home_assistant` 或 `facility/ttlock`；游戏机动作使用 `game_machine/machine_ws` 或 `game_machine/hinata_io`。前者由 PRiSM 机器客户端接收并 ACK，Hinata IO 按加密 HTTP relay 协议直接执行，TTLock 的 `door.open` 按 Cloud API 创建随机临时密码。Home Assistant、TTLock 和 Hinata IO 配置保存在 `app_settings`，由设备看板维护，运行时动态读取而不依赖部署环境变量；TTLock access token 过期时自动刷新并持久化新 token。玩家触发 `coin`、`aime.scan`、`power.on` 或 `power.off` 必须处于活跃计费 session；刷卡身份由后端从玩家绑定身份中解析。玩家发起除 `door.open` 门禁外的有效设备操作（如投币、刷卡、开关电源）入队或执行成功后，会自动将名下活跃计费场次标记为已操作设备（`deviceOperated: true`），作为计费引擎失效首次宽限期的判定依据。执行失败信息写入命令 payload 供员工后台审计；TTLock 临时密码仅通过本次成功响应返回，不写入审计记录。
- 统一的持久化仓储接口及其 SQLite 与 D1 双适配器实现。
- 可热启用的计费配置仓储（支持后台启用/禁用/归档/还原），在结账时动态解析。
- 运行时插件系统：支持注册业务线特定的计费规则与资产效果。插件计费逻辑在结算时叠加生效。
- 购买非计时服务项目（`BusinessItemOrder`）的完整闭环，限制必须在活跃场次内购买，支持核销履约与取消。
- 内建的资产计费效果只读取资产定义绑定的 `PricingEffect`。application 的统一效果解析器负责生效日期（开台或结账时任一有效）、作用域、定向方案额度上限跟踪、最低消费门槛（`minSubtotal`）、卡券数量守恒及适用范围过滤；比例折扣计算保留角分精度；资产 `metadata` 不参与结算。
- 员工资产操作命令：人工授予/增删/ revoke。
- Aime 卡扫码自动绑定并转换命令发送至机器软件通道。
- 机器软件状态定时上报并于 Staff Web 展示；Home Assistant 状态读取由 runtime 外部适配器实现，application 的同步服务负责并发读取、容错和批量持久化，Hono 只触发服务并返回缓存结果。
- 员工前台覆盖结算（Checkout Override）：手动改单，溢出部分自动以 `staff.override` 存入调整记录。
- 财务报表读模型：聚合收入、场次数量、正向资产流水笔数和出币次数；结账明细与玩家排行使用 `limit`/`offset` 分页并返回 `hasMore`，避免 Dashboard 把首屏结果误作完整数据。
- 基于 Hono 的员工 API，以及新的 Flutter Web 后台 `prism_dashboard`。`/admin` 只保留部署提示页，正式管理端从 `packages/prism-dashboard` 构建。
- 现场运营读模型：`/rpc/staff/live-players` 将玩家、钱包、在场时间、预计应付和未结 sessions 聚合为玩家优先的视图。未结 sessions 包含 active sessions，以及已经停止但仍是 unpaid 的 closed sessions；停止后的计时项仍留在玩家账单中，直到玩家级统一结账。每条 session 会带出当前结算预览中的 `pricingCharges`，展示该计时实际命中的计费方案、时段规则和金额；方案名称来自员工计费配置，取不到时才退回方案 ID。单条 `stop` 只停止某个 session 计时，不扣款；玩家级 `preview`/`confirm` 负责统一预览与结算。管理员加开计时时可指定这条计时使用哪些计费方案，后续资产计费效果也可以继续精确到这些方案和规则。

## 暂缓实现（Deferred）

- 员工账号使用 Passkey 或外部身份提供商登录。
- 除 Home Assistant/TTLock 网关/Hinata IO 扫码/本地投币机之外的更多硬件厂商预设集成。
- 编译期的 Hono 路由与响应体强类型客户端生成。
- 更复杂的报表图表与批量操作。
- 计费配置的多版本灰度回滚管理。
