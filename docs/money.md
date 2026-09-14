# 金额精度约定

PRiSM 的所有金额以元（`number`）表示，持久化在 SQLite/D1 的 `REAL` 列里 —— 也就是 IEEE-754 双精度浮点。这份文档说明由此带来的约束、当前采用的规则，以及后续的收敛路径。

## 为什么需要这份约定

二进制浮点无法精确表示大多数十进制小数。`0.06` 实际存成 `0.059999999999999998`，`0.07` 存成 `0.070000000000000007`，因此：

```
0.01 + 0.06 < 0.07   →   true
0.3  + 0.6  < 0.9    →   true
```

误差本身在 1e-17 量级，对现实金额毫无意义。**它只在代码把它转成「是 / 否」判断时才成为缺陷**，而代码里恰好有三类这样的判断：

| 写法 | 被误差放大成 |
|---|---|
| `available < amount` | 余额够付却抛 `INSUFFICIENT_BALANCE`，结账失败 |
| `quantity > 0` | 1e-16 的残渣被判为「有余额」，资产永不归零 |
| `amount === 0` | 1e-16 不等于 0，早退失效，继续走扣款再抛错 |

误差方向**不固定**：`0.1 + 0.2` 偏大，`0.01 + 0.06` 偏小。因此没有任何单向取整能修好它，只能加容差或先量化到分。

在真实数据上量过：穷举 4,000,000 组「赠送余额 + 充值余额」，令应付金额恰为两者的十进制之和，其中 456,808 组（11.42%）在旧写法下会被误判为余额不足。同一批数据在修好之后是 0 组。

## 统一入口：`packages/core/src/money.ts`

不要在这些模块之外自己写金额比较或取整。

| 导出 | 用途 |
|---|---|
| `MONEY_EPSILON` (`1e-9`) | 比较容差。比实测浮点噪声（1.39e-16）高七个数量级，比最小金额（1 分）低七个数量级。**不要调紧到 1e-15** —— 反复相减的残渣会到 1e-16~1e-15，那个量级会让比较重新翻转。 |
| `quantizeMoney(v)` | 量化到整分，`Math.round(v * 100) / 100`。用于**算术的输出**（求和、分摊、折扣、增量）和**外部边界**（API 入参、账本读入）。非有限值原样透传，调用方保留自己的 `Number.isFinite` 校验。 |
| `normalizeQuantity(v)` | 把浮点残渣收敛成**精确的 0**，其余量化到分。用于 `a - b` 链条的余额写回，使存储行真正能归零。 |
| `isPositiveQuantity(v)` / `isZeroQuantity(v)` / `isNegativeQuantity(v)` | 带容差的正 / 零 / 负判断。替换所有 `> 0`、`<= 0`、`=== 0`。 |
| `compareMoney(a, b)` | 三段比较，`compareMoney(available, amount) >= 0` 取代 `available >= amount`。 |
| `sumMoney(values)` | 累加后量化到分。**不要用朴素 `+=` 累加金额数组** —— 10000 笔 0.10 元朴素累加得 1000.0000000001588。 |

### 两条例外

- **`diffAssetHoldings` 内部对数量用精确 `===`。** 这是「有没有变」的持久化判断，不是业务比较：任何真实变化都应触发 upsert，容差反而会静默漏掉亚分变化。前提是调用方已经过 `normalizeQuantity`，两侧都是规范值。
- **分钟数是计数不是金额。** `unitMinutes`、`roundGraceMinutes` 不做量化。

## 入参量化点

超精度金额不能进入存储。当前已在这些边界量化：

| 位置 | 字段 |
|---|---|
| `core/src/pricing-config.ts` `quantizePricingProvider()` | `unitPrice`、`priceCap`、`charged.fixed.amount`、`paidHistory` 各项 |
| `application/src/staff-pricing.ts` | 保存与预览定价配置时统一调用上面的函数 |
| `application/src/staff-business-items.ts` | 服务项目 `price` |
| `application/src/staff-pricing-effects.ts` | `discount` / `surcharge` 的 `value`（`percentage-discount` 是百分比不是金额，不量化） |
| `application/src/staff-assets.ts` | 人工调整 `amount` |
| `platform/src/validators.ts` | `hourlyPrice`、`dailyCap`（`.transform(quantizeMoney)` 放在区间校验之后，让错误信息针对用户实际输入的值） |

量化只保证值是「整数分」，它**不消灭舍入，只把舍入变成确定的**。三处比例运算在分制下必然除不尽，必须各自定义舍入策略并保证守恒（各段之和等于原始总额）：

1. 百分比折扣 —— `application/src/asset-definition-effects.ts` 的 `calculateAssetEffectDiscount`
2. 封顶摊销 —— `core/src/pricing-time.ts` 的 `item.amount * (overlapMs / totalMs)`
3. 跨会话统一分摊 —— `application/src/settlement.ts` 的 `calculateUnifiedCheckoutDetails`

现有实现按「最后一段吃掉余数」保证守恒（见 `calculateUnifiedCheckoutDetails` 中的 `amountBeforeLast`）。

## 已知残留风险

- **存储仍是 `REAL`。** 阶段二落地后，领域层可以靠 `Cents` 让类型系统看见单位，但存储侧仍靠 `storage-sql` 一处换算维持；`REAL` 列要等阶段三才变。`packages/migration/src` 里保留了「迁移时保留小数余额」的测试（`preserves fractional wallet balances during migration`），说明小数余额是被允许写入的数据形态。
- **`settlement_charge_items.amount` 存的是定价引擎的原始输出。** 结算总额、覆盖金额、分摊结果都过了量化，但单个费用细项没有改写，消费者若要对细项做金额判断请走金额工具。
- **跨进程一致性。** SQLite 的 `SUM()` 内部是 Kahan 补偿求和，比 JS 朴素累加准；报表与余额必须都走 `sumMoney` / `sumCurrencyHoldings` 才能给出同一个数。
- **读路径的聚合也要量化。** 钱包余额在 `storage-sql/src/read-models.ts` 的 `getPlayerSummary` 里按 `asset_code` 聚合 ——
  这是整条读路径上唯一做算术的地方，已改为过 `quantizeMoney`。实测两位小数两两相加有 **22.7%** 会漂移
  （`0.01 + 0.05` 朴素得 `0.060000000000000005`），且玩家确实可能对同一币种持有多行（不同有效期窗口）。
  回归测试：`packages/storage-sql/test/wallet-precision.test.ts`。

## 后续收敛路径

| 阶段 | 内容 | 消掉什么 | 动存储 |
|---|---|---|---|
| **一（已完成）** | `money.ts` 统一容差与量化；核心结算、资产、application 层全部改用它；入参边界量化 | 拒付、残渣、`=== 0` 失灵、超精度入库 | 否 |
| **二（类型层已完成）** | `Cents` / `Units` 两个 branded 整数类型与全部运算在 `money.ts` 落地；调用方尚未切换 | 建立类型纪律 | 否 |
| **三** | 13 个 `REAL` 金额列改为 `INTEGER` 分；一次性 `ROUND(x * 100)` 迁移 | 根治 | 是，需停机窗口 |

## 阶段二：整数类型

`money.ts` 现在同时提供两套类型。**上面那套元制的容差工具是阶段的过渡形态**，下面这套是收敛方向。

| 类型 | 含义 | 构造 |
|---|---|---|
| `Cents` | 金额，整数分 | `centsOf(元)`（入参边界）、`centsOfInteger(整数分)` |
| `Units` | 计数（券、票据、席位），整数个 | `unitsOf(整数)` |

**已决定采用统一标度（2026-09-15）**：资产建模理论上是异构的 —— 数量列可能装金额、张数、甚至时长，
因此**只用一个品牌**，不再区分 `Cents` / `Units`。对 `currency` 资产它就是分；对其他资产它是「该资产单位的百分之一」
（例如 1 张券存成 `100`，30 分钟存成 `3000`）。

统一标度的代价已确认并接受：裸数据里 `100` 的含义取决于 `asset_type`，读库时不可自解释；
且计数资产一旦出现小数会被静默截断。换来的是领域层只有一种数量类型、一套运算，不需要按资产类型分支。

品牌类型**不拦截算术运算符**（实测 `cents + 裸number` 编译通过，因为它继承自 `number`），它拦的是赋值与函数传参。
所以算术结果会掉回裸 `number`，要写进金额字段必须显式过一次 `centsOfInteger` —— **存储边界才是真正被强制检查的关口**。

### 金额运算

| 导出 | 用途 |
|---|---|
| `addCents` / `subCents` / `negCents` / `absCents` / `sumCents` | 精确整数加减 |
| `compareCents` / `minCents` / `maxCents` / `isZeroCents` / `isPositiveCents` / `isNegativeCents` | 比较与判定。**整数比较就是普通 `<`，不存在「接近但不相等」** |
| `yuanOf(cents)` | 出参边界：转回元放进 JSON |
| `mulDivRound(cents, num, den, mode)` | `value × num ÷ den`，`mode ∈ floor / ceil / trunc / half`，**没有默认值**，内部用 `BigInt` 避免中间乘积溢出 |
| `allocate(total, weights)` | 按权重守恒分配。前 n−1 个取按比例的向下取整，余数按小数部分从大到小逐分派发（同分按下标）。**各段之和恒等于总额** |

**不要提供通用的 `money.multiply(ratio)`。** 三处比例运算在分制下必然除不尽，通用乘法等于静默舍入 —— 那比浮点误差更难查，因为它产生的是系统性的账单不平，而不是随机的 1e-17。每个调用点都必须显式说出它要哪个舍入方向。

`allocate` 的守恒是构造性保证的，不只是「通常成立」，因此它取代「各自独立取整再求和」的写法。

### 边界

- **入参**：API payload、旧库 `REAL` 列 → `centsOf`。它必然取整，所以 `10.01001` 这类超精度值在这一步被吸收，不会继续传播。
- **出参**：`yuanOf` → JSON。JSON number 本来就是 double，`fen/100` 得到的近似值（`1001 → 10.0099999999999997868…`）是正确的 —— wire 上不做任何比较，这点表示误差到展示层就被抹平。
- **带类型标注的整数分**：`centsOfInteger`。**不要拿它包装元值**，那是 100 倍的错。

### 已验证的性质

- 两位小数的合法输入穷举 **0.00 … 20000.00（2,000,001 个）全部准确转换，零误差**。`Math.round` 只在超合同（3 位以上小数）输入上按 double 真值取整：`1.005` 实际是 `1.00499999999999989…`，所以落在 `1.00`。
- `Cents` 与 `Units` 的互不可赋值由 `@ts-expect-error` 在测试里断言，且 `core`/`application`/`storage-sql` 的 tsconfig 包含 `test/`，所以 `bun run typecheck` 会校验这些断言仍然成立。

### 切换涉及面（实测）

把 `AssetHolding.quantity`、`ChargeItem.amount`、`SettlementAdjustment.amount`、`Settlement.subtotal/total` 临时声明为 `Cents`，编译错误分布：

| | 数量 |
|---|---|
| 生产代码 | **23**（`core` 15、`storage-sql` 6、`migration` 2） |
| 测试 | **176** |
| 合计 | 199 |

即：`application`、`server-hono`、`runtime`、`platform`、两个适配器**零改动**。生产侧的改造集中在 `core`（结算与资产算术）与 `storage-sql`（唯一的换算边界）。测试占了大头，需要用「元字面量 → `Cents`」的辅助函数做机械化改写。

结论：**阶段二不需要动数据库、不需要停机、可随时回滚**；它的成本主要在测试改写，而不是生产逻辑。

阶段一对应的回归测试：

- `packages/core/test/money.test.ts`
- `packages/core/test/settlement.test.ts` → `describe("settlement money precision")`，含 90,600 组 (赠送, 充值) 分位穷举
- `packages/core/test/asset-grant.test.ts` → `describe("asset holdings money precision")`
- `packages/core/test/pricing-config.test.ts` → `describe("quantizePricingProvider")`
- `packages/platform/test/validators.test.ts`

阶段二对应的测试（`packages/core/test/money.test.ts`）：

- `describe("centsOf / yuanOf")` —— 边界转换、两位小数穷举、超合同输入的确定性行为
- `describe("mulDivRound")` —— 四种舍入方向（含负数）、BigInt 精度、非法比例拒绝
- `describe("allocate")` —— 守恒（多种权重 × −50…50 全量）、余数归属、零权重、负数总额
- `describe("units arithmetic")` —— 计数加减
- `describe("the two brands do not mix")` —— 编译期品牌约束

阶段三的迁移可照 `migrations/0008_decimal_money_values.sql` 的 rebuild 模式（`CREATE 新表 → INSERT SELECT → DROP → RENAME`）执行；停机要求参照 `migrations/0016_shop_scoped_billing.sql` 文件头那句 "Run with all old writers stopped"，迁移前必须在每个生产库上复扫一遍金额小数位。
