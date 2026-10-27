# 从 prism-neo 数据迁移指引

PRiSM Next 提供了完整的历史数据平滑过渡方案。数据迁移过程主要分为两个步骤：

1. **导出数据**：将旧版 `prism-neo` 数据库的数据导出为一个符合标准定义的 JSON 快照文件。
2. **转换并导入**：通过 `@prism/migration` 包将 JSON 快照中的旧实体字段映射为 PRiSM Next 领域记录，并通过兼容的 SQL 执行器写入目标 SQLite 或远程 D1 数据库中。

除了命令行流程，后台「店铺设置 → 数据管理 → 从 JSON 导入」也支持直接选择 prism-neo 的 `pg_dump` 备份（`.sql`）或 CLI 导出的 JSON 快照：浏览器会先在本地将其转换为 PRiSM v3 备份，再走与普通备份完全相同的分片上传和覆盖导入流程（见 [店铺 JSON 数据备份与迁移](shop-data-transfer.md)）。网页导入同样遵守每月额度；快照带有旧计费规则时，「Legacy time priority pricing」直接启用并作为默认资源组的方案（默认资源组里的资源因此计费，前台收银关闭），`paid` / `free` 余额货币缺失时自动补齐（见下文第 E 节）。没有计费规则的快照不设方案，资源免费使用。网页导入只替换玩家、余额、计费方案和历史记录，店铺名称、封面、位置与时区、各项设置、资源、资源组、Bot 和店员保持目标店铺原样（文件标记为部分备份，见 [店铺 JSON 数据备份与迁移](shop-data-transfer.md)）；目标店铺原有资源组上已被替换掉的方案会清空。

---

## 1. 迁移导出命令行操作

根据旧系统所选的持久化数据库类型，执行对应的导出命令：

### 选项 A：从 Postgres 运行实例直连导出
```bash
bun run migration:export-postgres --url "$DATABASE_URL" --output ./exports/prism-neo-export.json
```

### 选项 B：从 Postgres `pg_dump` 备份文本文件导出
如果数据库不可直接外网连接，可从 `pg_dump` 的备份 SQL 文本文件（如包含 `COPY public."Table" (...) FROM stdin;` 数据块）直接解析提取：
```bash
bun run migration:export-postgres-dump --input ./exports/prism-neo.sql --output ./exports/prism-neo-export.json
```

### 选项 C：从旧系统的 SQLite 备份库导出
```bash
bun run migration:export-sqlite --sqlite ./exports/prism-neo.sqlite --output ./exports/prism-neo-export.json
```

---

## 2. 导入到 PRiSM Next 数据库

### 步骤 1：导入到本地/中间 Staging SQLite 库中进行核对
```bash
bun run migration:import-json --input ./exports/prism-neo-export.json --sqlite ./data/prism-next-staging.sqlite
```
该命令会自动初始化目标 schema，写入映射后的记录，并打印统计出来的玩家、资产、场次、结算、计费流水、礼物及 CDK 兑换明细。

导入器按目标表生成多行 `INSERT ... VALUES`，并在冲突时保持原有 upsert 语义；为同时兼容 SQLite 与 D1，单条语句最多使用 100 个绑定参数，超出时自动分块。结算概要、费用项和调整项属于不同表，仍分别批量写入，但不会再为每一行执行一条 SQL。

### 步骤 2：启动本地后台验收数据
```bash
PRISM_SQLITE_PATH=./data/prism-next-staging.sqlite bun run dev:local
```
打开 `http://localhost:8787/admin`，此时系统还没有店主账号，会进入 OOBE 初始化向导。

> [!TIP]
> 迁移数据中包含充值余额 `currency/paid` 与赠送余额 `currency/free`。在 OOBE 的第一步中，建议继续填写与旧系统一致的代币名称与结算符号（例如旧系统的“点数”和“积分”），以便新旧系统代币余额数据无缝融合。

### 步骤 3：（可选）将验收通过的 SQLite 数据迁移至远程 Cloudflare D1
对于云端部署，建议将本地 staging SQLite 转换为 SQL 后批量写入 D1：
1. 提取 SQLite 中的纯数据 `INSERT` 脚本：
   ```bash
   sqlite3 ./data/prism-next-staging.sqlite ".dump --data-only" > ./exports/prism-next-data.sql
   ```
2. 在 `.env` 中设置好 `D1_DATABASE_ID`，生成当前部署者的 Wrangler 配置并应用初始 D1 结构升级：
   ```bash
   bun run wrangler:config
   bun run db:migrate:remote
   ```
3. 向远程 D1 导入数据数据：
   ```bash
   bunx wrangler d1 execute prism --remote --file ./exports/prism-next-data.sql
   ```
4. 部署 Worker 并登录测试：
   ```bash
   bun run deploy:worker
   ```

---

## 3. 数据映射 invariants (映射规则明细)

### A. 稳定实体 ID 映射策略
为了避免历史整数 ID 同新系统的 UUID 发生冲突，并防止数据错乱，所有从旧系统导出的记录均使用稳定命名空间前缀进行转换：

- `User.id` -> `legacy:user:<id>`
- `Session.id` -> `legacy:session:<id>`
- `UserAsset.id` -> `legacy:user-asset:<id>`
- `UserAssetLog.id` -> `legacy:user-asset-log:<id>`
- `Present.id` -> `legacy:present:<id>`
- `Redeem.id` -> `legacy:redeem:<id>`
- `CoinRecord.id` -> `legacy:coin-record:<id>`

这使得所有历史交易在审计视图中皆清晰可溯。

### B. 资产类型映射

| 旧 prism-neo 资产类型 | 新 PRiSM Next 资产映射 |
| --- | --- |
| `CURRENCY / 10001` (充值余额) | `type=currency, code=paid` |
| `CURRENCY / 10002` (赠送余额) | `type=currency, code=free` |
| `PASS / 10001` | `type=pass, code=legacy.pass.10001` |
| `TICKET / 10001` | `type=ticket, code=legacy.ticket.10001` |
| 其他道具或称号资产 | `<lowercase type> / legacy.<lowercase type>.<assetId>` |

旧系统资产定义中的元数据和启用状态都会妥善存入 `AssetDefinition.metadata.legacy` 下。在旧系统中被隐藏的资产持有，会被系统自动标上 `metadata.hiddenFromPlayer: true`，继续对玩家隐蔽但对员工可查。

### C. 玩家与卡券身份绑定映射
- `User.isBanned = true` 对应的用户在系统中转换为 `banned`（封禁）状态。其他状态映射为 `active`。
- 旧 `Bind` 数据会被存入 `player_identities` 中。例如，QQ 绑定将转化为 provider 为 `qq`，subject 为原始卡号或 QQ 号的实体映射，使机器人能自动识别该卡片。
- 员工玩家列表会把这些外部身份作为摘要返回，后台玩家档案会直接显示诸如 `QQ 826225045` 的绑定项，便于店员核对迁移结果。
- 旧用户由于没有设置中文昵称，迁移后系统自动将其默认显示名设置为 `Player <old_id>`，后续可在后台随时修改。

### D. 场次与历史账单结算映射
- 已关闭场次迁移后状态保持为 `closed`；其中带有旧系统最终结账金额 `Session.finalCost` 的场次会写入 `payment_status = paid`，避免玩家级统一结账再次把历史账单纳入待结算区间。
- 已关闭但没有 `Session.finalCost` 的旧场次会保留为 `payment_status = unpaid`，迁移后仍可通过统一结账流程补结。
- 未关闭活跃场次保持为 `active`。
- 旧系统的最终结账金额 `Session.finalCost` 映射为 `settlements.total`。
- 如果结算额与计费计费 subtotal 不等，系统会自动在账单中派生一条结算调整项（Adjustment）来还原账单。
- 旧 `BillingRecord` 数据全部平移至 `pricing_history_entries`。由于计费引擎会根据玩家的“消费封顶限额锚点（`ruleAnchorAt`）”判断是否达到了每天的扣费上限，这些历史数据的完整平移能够保证迁移后玩家的封顶限额继续生效。

### E. 计费方案映射
- 旧的 `BillingRule` 计费配置会被合并导入为一个名为 `Legacy time priority pricing`（历史优先级计费方案）的配置中。
- **网页导入**（`packages/prism-web/src/prism-neo-convert.ts`）：方案以启用状态导入并设为默认资源组的方案，`cashierEnabled: false`（自助结账），与 prism-neo 原本的运营方式一致；导入后无需重新创建货币或计费方案。旧规则的裸时钟按**导入目标店铺的时区**解释，并用 `migrateCurrentPricingRules` 转为 UTC 存储（区间、星期与指定日期一并平移），例如上海的 `20:00–次日 04:00` 存为 UTC `12:00–20:00`；`isDateTimeRange` 节假日规则本身是绝对时间，不做转换。导入前请确认目标店铺的时区与旧部署一致，导入后仍建议在 `/admin` 后台比对 24 小时时间轴。
- **命令行导入**（`packages/migration`）没有店铺时区来源，仍原样复制裸时钟并以停用状态（`enabled: false`）导入；启用前须按旧部署实际时区核对并转换区间、星期和日期，例如上海的 `10:00–次日 03:00` 应存为 UTC `02:00–19:00`，详见 [计费时区字段审计](pricing-time-zone-audit.md#独立的-prism-neo-导入缺口)。

### F. CDK 与出币记录映射
- 礼物（`Present`）与 CDK（`Redeem`）正常平移，历史合并发放策略自动转化为 `stack` / `extend-time` / `replace`。礼物授予里的 `activeAt` / `expiresAt` 会在 PRiSM Next 仓储层恢复为 `Date | null`，兼容旧 JSON 快照和 pg_dump 导入后的字符串日期。礼物授予的货币数量按资产持有同样的存储单位（分）写入，网页导入与命令行导入结果一致，不会再在显示时被缩小 100 倍；`extend-time` 的 `durationMs` 会保留。旧礼物内容上的 `oncePerUser`（该内容只在首次兑换时发放）会转为该内容的 `maxPerPlayer: 1`。
- 旧的投币日志 `CoinRecord` 均会转化为已确认（`acked`）的 `coin` 通道设备命令记录，作为设备审计和投币数量统计的基础，而不会重新触发任何物理出币动作。

### G. 旧配置中的硬件连接迁移

`prism-neo/src/config.json` 不属于业务数据库快照，通用 JSON 导入命令不会自动处理其中的硬件凭据。迁移 TTLock 时，将旧 `door.clientId`、`clientSecret`、`appAccount`、`appPwd`、`accessToken`、`refreshToken` 和 `mainLockId` 分别转为 `devices.ttlock_connection` 与 `devices.ttlock`；门锁映射必须补充后台可读的 `id`、`name` 和 `aliases`。迁移后应在设备看板的 TTLock 设置中复核 API 地址和门锁 `lockId`。当前 `/lock` / `door.open` 的行为是通过 TTLock 云端创建 8 位随机临时密码（默认有效期 3 分钟），不是直接调用远程解锁；门锁需要支持 TTLock 临时密码下发。Home Assistant 的 URL、Token 和实体映射同样应写入后台设置，不要放入仓库或 Worker 构建日志。

---

## 4. 迁移后需要人工重构的内容

这些特定于部署细节的配置不会随数据表自动迁移，需要在 OOBE 向导和后台中重新配置：

- 商家和前台收银员的管理员账号（旧系统的 admin 表不会迁移，防止密码泄漏）。
- 机器人/店内入口的 Integration API Token、机器软件的 Machine API Token，以及玩家 Web 的 player session 登录流程。旧的 Bot/Player/Agent 静态 Token 废弃，不能继续迁移到新系统。
- 旧的主机环境变量设置。
- 物理出币机、Aime 桥接、门禁、插座和 Home Assistant/TTLock/设施网关的网络配置。投币和 Aime 走 Machine WebSocket，电源和空调通常接入 Home Assistant，TTLock 门禁使用 `devices.ttlock_connection` 与 `devices.ttlock` 配置；这些密钥由后台设置保存，不依赖 Worker 环境变量。

---

## 5. 迁移异常回滚方案

### 本地 SQLite 方案回滚
```bash
cp /backup/prism-before-cutover.sqlite /absolute/path/to/prism.sqlite
```

### Cloudflare D1 方案回滚
- 在导入前建议先备份 D1 数据：`wrangler d1 export prism --remote`。
- 若发生故障，可通过 Cloudflare 仪表盘中的 **Time Travel** 服务将 D1 恢复至特定时间戳状态。
