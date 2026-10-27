# 前台收银（React Web，低安全模式）

用于有工作人员的店铺：玩家持实体卡到前台入场与结账，店铺负责人在 React 商户管理页面的「设置」中手动打开「启用前台收银」，店员在「在店」页面连接 HINATA 读卡器后等待刷卡。前台收银模式默认关闭，启用后与在店玩家列表共用一个页面，不增加独立导航标签。店铺须启用计费，店员须拥有 owner 或 manager 权限；viewer 不能进行前台操作。复用店铺现有入场计费方案、价格版本、封顶规则和账单时间线，无需玩家 GPS 或设备二维码。

## 操作流程

1. 还没有余额货币和计费方案的店铺可先在「设置」使用[快速创建计费](billing-setup.md)向导，无需 Bot 凭据。负责人进入「设置」，勾选「启用前台收银」，再选「前台资源」并保存。前台是一个资源：前台刷卡入场开始的就是它的方案（它自己的方案，否则它所在资源组的方案），没有默认计费方案。没选前台资源时不能开启（`409 CASHIER_RESOURCE_REQUIRED`）；前台资源所在资源组免费时入场返回 `409 RESOURCE_NOT_BILLED`。迁移 0045 已给原来开着前台收银的店铺建好名为「前台」的资源。存在进行中或已停止但未付款的前台计时时，须先收款结账才能关闭模式。关闭后保留已有昵称档案、卡片绑定和收款记录，再次启用可继续使用原卡。
2. 使用支持 WebHID 的桌面 Chrome / Edge，通过 HTTPS（开发时 localhost 也可以）打开管理页面，点击「连接读卡器」并授权 HINATA 设备。再次打开收银区域会自动连接已经授权的读卡器；拔出后显示断开，重新接入后自动初始化并恢复读卡。关闭其他占用该读卡器的程序或浏览器页面。
3. 新卡刷入后，询问玩家昵称，点击「登记并入场」。仅创建当前店铺的计时档案并绑定基础 ID，不创建 PRiSM 账号、不要求平台身份、不发注册赠品。
4. 已绑定卡再次刷入时，无未结账计时则显示「确认入场」；有进行中或已停止但未结账的计时则显示账单。入场和结账均须店员确认，刷卡本身不会扣款或结束计时。
5. 结账时按显示金额通过店铺自己的微信、支付宝、现金或其他方式收款，勾选「我已通过上述方式收到款项」，点击「确认已收款并结账」。PRiSM 记录原始账单、收款方式、收银员和收款时间，不连接第三方支付系统，也不扣除或创建任何资产。
6. 金额与计时截止到该次账单预览时间，确保收款时不会因跨过计费边界而多收或少记。预览十分钟后过期；计时或金额发生变化也会拒绝提交，请刷新账单、核对金额后再确认。取消结账不会停止计时；在店页面的「停止计费」仍保留未付款账单，之后可在前台收款。
7. 操作成功后回到等待刷卡状态。同一张卡留在读卡器上不会反复触发；移开卡片再刷。处理当前玩家期间刷另一张卡不会替换当前玩家，页面会提示完成后重新刷卡。

读卡登记、入场和收款成功后，「在店」列表会自动刷新；在店账单的「前台收款」和玩家资料中的「前台收银」均在「在店」页面处理对应档案。刷卡或点击「前台收款」时，页面会滚动到收银区域。「营业记录」区分现场收款与资产结算并显示收款方式。正常账号玩家的资产与自助计费流程保持原有行为。

## 卡片和安全边界

通信链路移植自 [Project-HINATA/hinata_go 的 `3ca80cc`](https://github.com/Project-HINATA/hinata_go/tree/3ca80ccedb971b8c9de6e2817b2ff44f9f5be8aa)。对照文件包括 `plugins/hinata_nfc.dart/lib/src/core/hinata_reader.dart`、`core/subscription.dart`、`protocol/pn532.dart`、`transport/hid_bridge/hid_bridge_web.dart`，以及 `lib/services/reader/usb_hinata_impl.dart`、`lib/providers/hardware_device_provider.dart` 和 `current_scan_session_provider.dart`。PRiSM 的对应实现是 `card-reader.ts`、`reader-subscription.ts` 和 `reader-manager.ts`。

使用 WebHID vendor ID `0xF822`，输出 report ID `1`；输入按数据首字节分发到订阅，只有 report ID `2` 单独走 CardIO 通道，不能假设响应的 report ID 必须为 `1`。Go 的测试使用 report ID `0`，旧实现过滤掉此类响应会产生超时。PN532 使用桥接命令 `0xE2`、标准帧和校验；接受 ACK、忽略其他命令的响应，按每次接收设置独立的 1000ms 超时，计时从 HID 写入完成后开始。收到 ACK 后继续等待对应命令的响应；请求成功、失败或取消均结束对应订阅。

只读取 Type A UID（4/7/10 字节）或 FeliCa IDm（8 字节），不要求 Aime、Banapass、交通卡等应用格式、不读取受保护扇区、不导入游戏卡 access code。

### 初始化、事件订阅和重连

- 按 Go 等待 HID collections 数量大于 2，每 50ms 检查一次，最多 60 次；仅在设备尚未打开时调用 `open()`，先注册输入事件，再发送固件时间戳请求 `0x01`，其响应首字节为 ASCII `2`（`0x32`）。按固件版本读取 `0xE5` commit、`0xE6` chip ID，以及 `0xD4`/`0xD1` 启动配置；不插入额外的 RF 初始化指令。
- 移植 `count`、`never`、`specificIsOn`、`specificNotOn` 四种退订策略；接收队列按序消费，广播订阅可独立取消。发送 HID 指令前建立订阅，保留提前到达的响应；一次性订阅自动关闭后仍可取出已缓冲的响应。CardIO report `2` 保留独立订阅接口，不作为卡片计时凭证。
- 打开收银区域后订阅 HID `connect`/`disconnect` 事件并调用 `getDevices()` 枚举已授权设备；未授权设备须通过按钮打开选择器。重复连接事件不会建立第二轮轮询。每次连接和断开递增连接代次，过期枚举、握手和旧设备响应不能覆盖新连接；重新接入后使用新订阅完成固件握手再开始轮询。
- 拔出、手动断开和离开收银区域都会取消响应等待、移除输入订阅、结束轮询并关闭设备；离开区域还移除 HID 连接事件监听。取消也覆盖尚未完成的 HID 写入。快速重连或 React 页面重挂载会等待前一连接关闭，避免旧连接关闭新连接。手动断开后保持断开，直到再次点击连接或物理重新接入。
- 每轮按 Go 先轮询 FeliCa（212kbps，初始数据 `00 FF FF 01 00`）；无目标时释放 `tg=1`，再逐档配置 RF 并轮询 Type A。标准版 PID `0x0147` 使用两档，Lite PID `0x0148` 使用三档，其他 PID 使用默认档；参数与 Go 一致。
- 轮询间隔 16ms；页面失焦时每 200ms 检查一次，暂停发送读卡指令。保留等待当前轮询结束后暂停、恢复轮询的接口。只有连续三次成功的无目标扫描才判断卡片已移开；超时或坏帧视为读取未完成，不清除卡片存在状态，也不重复触发玩家操作。

轮询失败时页面显示「读卡器本次读取未完成，正在重试」。单次失败仍继续轮询；连续三轮失败后自动恢复链路：等待 200ms，取消旧传输与订阅，关闭并重新打开同一已授权 HID 设备，重新完成固件握手，然后发送 HINATA Go `resetStateMachine` 对应的无响应命令 `0xE8`，等待 200ms 后恢复扫描。恢复握手失败时继续以 200ms 退避重试恢复，不会在握手未完成时发送扫描指令。无需打开设备选择器；整个恢复过程保留卡片存在状态，避免仍放在读卡器上的卡片重复触发玩家操作。暂停接口会等待当前扫描及恢复完成，停止或拔出会取消当前传输（包括恢复过程中建立的新传输）并阻止后续重试。只有下一次成功扫描才清除错误提示；重新打开或握手成功本身不表示扫描已恢复。

HID 写入另有独立的 1000ms 超时，防止 `sendReport` 挂起导致轮询永远不能进入响应等待或下一轮重试；写入超时、失败和取消均清除计时器及取消监听，底层写入随后失败也不会污染下一次请求。真实拔出时显示自动重连提示；首次连接握手失败保持未连接，可以重新选择设备。超时或坏帧的「读卡器通信详情」包含命令、轮询协议/RF 档位、帧数及最后响应的 report ID，便于区分未收到任何响应与收到 ACK 后未收到数据；写入超时会标记 `write` 阶段。现场仍出现超时时可记录这些详情及读卡器型号、固件版本后排查。

当前 Go 的扫描循环同样会重试，且提供 `resetStateMachine` 接口，但没有在扫描失败后自动调用该接口；PRiSM 的持续失败恢复属于额外的恢复措施，不能仅凭截图认定两者在单次响应超时处理上不同。模拟 HID 回归测试覆盖持续零响应、仅 ACK、写入挂起、迟到的写入失败、恢复握手失败后再次恢复、恢复握手中拔出以及恢复时暂停。恢复期间请求暂停时，恢复结束后不再启动扫描，须显式恢复轮询；这些测试不替代实体设备验证。

这里的「任何卡片」指读卡器能通过上述协议读取基础 ID 的卡片。ISO15693、Type B、手机系统 NFC、非 HINATA WebHID 设备和高安全模式不在本次实现范围内。随机 UID 的手机或卡片不适合作为稳定入场凭证。真实设备仍需现场确认固件和浏览器兼容性。

UID 可以被复制，仅用于店员监督下的店内计时档案。卡片档案按店铺及卡片协议类型隔离，相同基础 ID 在不同店铺可绑定不同玩家；该凭证不授予账号登录或资产权限。店员可在玩家资料「身份与状态」中为前台档案添加外部平台身份（例如 `onebot:114514`、`telegram:114514`）。添加身份不会自动创建 PRiSM 账号，也不改变现场收款方式。玩家可使用自己的绑定码，通过店员或 Bot 验证平台身份后关联 PRiSM 账号，查看自己的计时和账单；卡片 UID 本身仍不授予账号登录权限。数据库和 API 继续拒绝为此类档案保存余额资产。前台档案不能经普通余额结账入口结账，须显式确认现场收款。

## 玩家身份展示

所有店铺玩家（含前台档案）的玩家列表和「在店」资料均显示已登记平台身份。已有 PRiSM 账号关联直接从 `shop_player_accounts` 读取，显示为「PRiSM 账号：账号显示名 · 账号编号」，不依赖是否在旧 `player_identities` 中存在 `web-account` 记录，不需要重新绑定；有旧记录时去重。未在当前环境验证匹配的导入账号不视为已绑定账号。

商户 `GET /staff/players` 和 `GET /staff/live-players` 的 `identities` 包含 `{provider:"web-account",subject:"当前环境账号 ID",displayName:"账号显示名"}`；普通平台身份的格式保持不变。账号身份是只读关联，通用身份添加/删除接口拒绝 `web-account`（`ACCOUNT_IDENTITY_READ_ONLY`），须使用已有绑定码验证流程，不能手工指定账号编号。owner 和 manager 可以登记平台身份，viewer 只有查看权限。

## API 与数据

店铺 `GET /api/v1/shops/:shopCode` 和 `GET /api/v1/shops/:shopCode/settings` 返回 `cashierEnabled`（无配置时为 `false`）。负责人通过 `PUT /api/v1/shops/:shopCode/settings` 提交 `cashierEnabled` 手动启停；旧客户端省略该字段时保留已有值。开关保存在已有 `app_settings` 的 `cashier.settings` 键，开启须同时启用计费，关闭须结清所有前台未付款计时。设置更新和登记、入场、收款共用店铺操作锁，避免关闭与新入场并发留下无法结账的计时。

平台 API 前缀：`/api/v1/shops/:shopCode/cashier`，沿用商户账号会话、来源校验和店铺 staff 权限。模式关闭时这些接口返回 `409 CASHIER_DISABLED`；关闭被未付款前台账单阻止时设置接口返回 `409 CASHIER_UNSETTLED_SESSIONS`。

- `POST /lookup`：`{kind:"type-a"|"felica", uid:"十六进制"}`，返回 `{profile:null|档案}`。
- `POST /register`：`{card:{kind,uid},displayName,operationId}`，创建空资产档案并绑定卡片。
- `GET /profiles/:playerId`：返回档案及所有未结账计时。
- `POST /profiles/:playerId/entry`：`{operationId}`，使用当前店铺入场计费方案开始计时。已有入场计时不会重复创建；已停止的未付款计时须先结清。
- `POST /profiles/:playerId/checkout/preview`：返回既有账单格式，包含 `settlementPreview.previewedAt`、`sessionIds` 和以元表示的 `total`。
- `POST /profiles/:playerId/checkout/confirm`：`{operationId,collected:true,method:"wechat"|"alipay"|"cash"|"other",expectedTotal,previewedAt,sessionIds}`。只有前台卡片档案可用，按预览截止时刻计算并核对金额与计时。`operationId` 必须为 UUID，网络重试使用原编号，以免重复处理。

新表 `cashier_profiles` 保存卡片绑定，`cashier_payments` 关联已有 `player_checkouts`，记录收银员、方式和时间。结账、会话关闭、价格历史与收款记录在同一数据库事务内提交；不创建资产交易或扣款流水。

Cloudflare D1 部署须应用 `migrations/0029_cashier.sql`（正常 `deploy:worker` 流程会执行未应用迁移）；支持前台档案的平台身份和账号关联还须应用 `migrations/0033_cashier_player_identities.sql`；它只移除身份/登录限制并更新空资产检查触发器，可重复应用，不更改玩家、卡片、资产、计时或收款数据。本地 SQLite 运行时会通过既有 schema 初始化自动添加表、升级旧触发器，并保留资产保护。无须更改现有玩家数据或配置支付密钥。

验证命令：`bun run typecheck`、`bun run build:web`、`bun test --timeout 30000`。读卡链路可单独运行 `bun test packages/prism-web/src/card-reader.test.ts packages/prism-web/src/reader-subscription.test.ts packages/prism-web/src/reader-manager.test.ts`，覆盖 report `0`/`1`、CardIO 隔离、提前响应、ACK 后等待、超时清理、固件版本握手、RF 档位、失焦、卡片存在状态、已授权枚举、初始化中拔出和重连。收银 API 可单独运行 `bun test packages/platform/test/cashier.test.ts --timeout 60000`。如果全量单进程运行中出现 Miniflare 运行器超时或共享模拟状态错误，可按测试文件使用独立 Bun 进程验证平台集成测试，保持所有断言启用。读卡协议单元测试使用模拟 HID 设备，收银接口测试使用真实 Miniflare D1；这些测试不替代实体刷卡实测。

界面回归：先运行 `bun run build:web`，再启动 `bun run --cwd packages/prism-web preview --host 127.0.0.1 --port 4173`，执行 `node scripts/check-player-identities-browser.cjs`。覆盖前台玩家身份表单提交、普通/前台玩家 PRiSM 账号展示、手机端账号昵称搜索，以及 viewer 的只读权限；截图默认输出至 `.scan-check/`。`check.yml` 的 browser 任务同样执行该检查，并上传截图。
