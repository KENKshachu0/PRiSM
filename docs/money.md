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

- **存储仍是 `REAL`。** 本约定靠纪律维持，类型系统看不见 —— 量化前后都是 `number`。`packages/migration/src` 里保留了「迁移时保留小数余额」的测试（`preserves fractional wallet balances during migration`），说明小数余额是被允许写入的数据形态。
- **`settlement_charge_items.amount` 存的是定价引擎的原始输出。** 结算总额、覆盖金额、分摊结果都过了量化，但单个费用细项没有改写，消费者若要对细项做金额判断请走金额工具。
- **跨进程一致性。** SQLite 的 `SUM()` 内部是 Kahan 补偿求和，比 JS 朴素累加准；报表与余额必须都走 `sumMoney` / `sumCurrencyHoldings` 才能给出同一个数。

## 后续收敛路径

| 阶段 | 内容 | 消掉什么 | 动存储 |
|---|---|---|---|
| **一（已完成）** | `money.ts` 统一容差与量化；核心结算、资产、application 层全部改用它；入参边界量化 | 拒付、残渣、`=== 0` 失灵、超精度入库 | 否 |
| **二** | 引入 `Money` 工具与 branded 类型 `type Cents = number & { readonly __brand: "Cents" }`，让编译器找出所有漏改的边界 | 建立类型纪律 | 否 |
| **三** | 13 个 `REAL` 金额列改为 `INTEGER` 分；一次性 `ROUND(x * 100)` 迁移 | 根治 | 是，需停机窗口 |

阶段一对应的回归测试：

- `packages/core/test/money.test.ts`
- `packages/core/test/settlement.test.ts` → `describe("settlement money precision")`，含 90,600 组 (赠送, 充值) 分位穷举
- `packages/core/test/asset-grant.test.ts` → `describe("asset holdings money precision")`
- `packages/core/test/pricing-config.test.ts` → `describe("quantizePricingProvider")`
- `packages/platform/test/validators.test.ts`

阶段三的迁移可照 `migrations/0008_decimal_money_values.sql` 的 rebuild 模式（`CREATE 新表 → INSERT SELECT → DROP → RENAME`）执行；停机要求参照 `migrations/0016_shop_scoped_billing.sql` 文件头那句 "Run with all old writers stopped"，迁移前必须在每个生产库上复扫一遍金额小数位。
