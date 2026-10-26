# 计费方案版本

方案管理保留稳定 `id`。每次创建或修改名称、规则、启用状态、归档状态，数据库保存完整且不可修改的版本，具有独立 `versionId`（UUID）和递增 `version`。只更新时间戳不会产生版本。管理接口返回这两个字段，原有客户端仍可按方案 ID 编辑。

每次方案变化自动发布一份店铺级 `pricing_releases`：只存各方案版本 UUID 的集合与业务时区（新发布固定为 UTC），不重复复制完整规则。单个方案版本包含名称、类型、状态和完整 provider 配置（所有区间、费率、封顶及关联方案 ID）。计时方案的 `requires` / `conflicts` 关系存放在 provider 的 `relations` 字段中，随版本一起不可变；没有关系的方案不写该字段，见 [计费状态编排](pricing-sessions.md)。关联方案的具体版本由同一发布集合确定。修改 UI 展示时区不会发布新集合。UTC 数据迁移等价转换历史发布的时区和规则，发布 ID 与会话绑定保持不变，见 [UTC 时间约定](utc-time-contract.md)。

入场会话通过 `session_pricing_releases` 引用发布版本。同一玩家还有未结账会话时，新增计费沿用最早未结账会话的版本，包括麻将开台。方案关系同样按该版本解析。不能追加该版本没有的新方案，须先结账后重新入场。数据库触发器让写方案、生成版本、发布以及入场绑定在原写操作中原子完成；失败全部回滚。版本、发布集合和会话绑定禁止修改与删除，跨店读取隔离。

结算从已绑定版本读取规则、名称、关联封顶和时区。途中编辑、停用、归档不会改变已有消费；全部结账后的新入场使用当前发布。不同发布版本的未结账会话异常混合时拒绝结算，避免重复应用封顶。

首版沿用原 provider / 封顶方案的累计键，衔接升级前已经支付的同区间金额；第二版起以版本 UUID 区分累计历史。修改方案会开启该方案新版的独立累计，未改动的封顶版本仍沿用其累计。优惠券适用方案仍按稳定方案 ID 判断。

账单时间轴继续保存结算结果快照，并记录 `pricingReleaseIds`，不复制整份方案配置。金额、结账后余额、当时的名称、规则分段是结算事实，不能仅凭方案版本替代。历史账单不使用现行方案重算。优惠券和插件代码不纳入此计费配置版本库。

## 升级

远程 D1 部署新版服务前应用 `0028_pricing_versions.sql`。本地 SQLite 初始化使用同一 schema，重复执行保留已有版本与绑定。迁移把现有配置保存为首版，并绑定尚未结账会话；已付款旧会话和旧账单不补造历史版本。此前从未保存的旧规则无法恢复。迁移不会重算金额或改写旧累计记录。

触发器的入场校验使用 `SELECT RAISE(ABORT,'PRICING_CONFIG_NOT_IN_RELEASE') WHERE <条件>` 形式，而不是 `SELECT CASE WHEN <条件> THEN RAISE(...) END`。远程应用迁移走 D1 `/query` 接口，其服务端拆分器按 `BEGIN`/`END` 配对划分触发器体，但不识别 `CASE` 结尾的 `END`，会把触发器从中间切断并报 `incomplete input: SQLITE_ERROR [code: 7500]`。本地 sqlite3、客户端拆分器和 `d1 execute --file`（走 `/import`）都不会暴露该问题，因此只能在部署时发现。新增迁移中的触发器需继续避免 `CASE`，并保持 `BEGIN` 大写。

验证：`bun test packages/server/test/shop-billing-routes.test.ts` 与 `packages/storage-sql/test/pricing-version-schema.test.ts` 覆盖编辑与归档期间入场锁定、时区锁定、直接 SQL 入场、新方案拒绝、账单版本引用、隔离、不可篡改、旧数据迁移、累计封顶衔接和失败回滚。`bun test packages/storage-sql/test/d1-migration-splitter.test.ts` 按 D1 服务端拆分方式回放全部迁移，并禁止触发器体内出现 `CASE`。全库测试另覆盖 SQLite / D1 schema 与现有收费路径。

UTC 历史转换使用 `historyProviderId` 保留历史及当前迁移版本别名的收费／封顶身份，`historyRuleId` 保留按日期偏移拆分后的原规则累计身份；绝对历史窗口的 `anchorAt` 保留原 UTC 封顶锚点。这些信息用于迁移后衔接累计，不改变金额；日常编辑保存会清除迁移身份，生成正常的新版本。
