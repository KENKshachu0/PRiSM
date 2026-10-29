# 会员卡与会员方案

以当前代码为准。会员卡是资产页里的一种普通物品，会员方案是它的售卖时长；资源和资源组可以分别配置普通计费方案与会员计费方案。

## 1. 会员卡

会员卡是资产定义为 `type = membership` 的物品，和其他资产一样：

- 在「资产」页新建，填写名称、编号，并绑定一个计费效果。
- 计费效果决定会员权益：`percentage-discount`（如减免 30%，即 7 折）、`free`（免单）、`discount`（固定减免）或 `surcharge`。
- 可以设置生效/过期时间、玩家是否可见、是否可叠加。
- 结算时由现有资产优惠引擎自动应用，不需要第二套折扣逻辑。

会员卡本身不限制张数。建议一家店只保留一张在用的会员卡，避免多张卡的优惠同时结算。

## 2. 会员方案

会员方案是「卖多久」：

| 字段 | 含义 |
| --- | --- |
| `name` | 方案名称，如月卡、季卡、年卡 |
| `assetCode` | 这张方案发放的会员卡 |
| `price` | 售价，API 用元，存储用分 |
| `durationDays` | 有效天数，1–3650 |
| `status` | 在售 / 已下架 |

- 同一张会员卡可以拆成多个时长方案。
- 续费使用 `extend-time`：从当前到期日顺延。
- 购买和店长发放都会写一条资产交易，记录方案、会员卡、价格和时长。
- 会员方案不需要数据库迁移；设置保存在 `app_settings` 的 `membership.program`。

## 3. 会员专属计费方案

资源组和资源各有两套计费绑定：

| 层级 | 普通方案 | 会员方案 |
| --- | --- | --- |
| 资源组 | `default_pricing_config_id` | `membership.resource_plans.groups[groupId]` |
| 资源 | `pricing_config_override_id` | `membership.resource_plans.resources[resourceId]` |

开始计费时：

```text
会员身份有效？
  是 → 资源会员方案 → 资源组会员方案 → 普通方案
  否 → 资源普通方案 → 资源组普通方案
```

- 会员方案优先于同一层级的普通方案。
- 资源没有会员方案时，会员回退到普通方案，会员卡优惠仍然生效。
- 资源组/资源都没有普通方案、也没有会员方案时，资源免费。
- 会员身份在**开始计费时**判断；已经开始计费的 session 不会因为中途购买、到期或取消会员而切换方案。
- 会员方案和普通方案都经过同一套方案关系（`requires` / `conflicts`）与计费版本锁定。

## 4. 折扣叠加

会员专属方案决定**规则**（时段、单价、封顶），会员卡效果决定**折扣**，两者默认叠加：

```text
会员方案算出金额 → 封顶 → 会员卡效果 → 钱包
```

例如会员方案 ¥20/小时，会员卡减免 10%，最终为 ¥18/小时。商家不要把会员方案本身再设成折扣价，否则会双重优惠；如果只想用会员方案定价，把会员卡的优惠设为无或 0。

## 5. 入口

### 玩家

扫码页在已绑定店铺账号时显示会员卡：

- 未开通：列出售卖方案，玩家用余额购买。
- 已开通：显示会员卡名称、折扣和到期日。
- 购买带 `operationId`，重试不会重复扣款。

接口（店铺前缀 `/api/v1/shops/:shopCode`）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/player/member` | 会员设置、在售方案、当前会员状态 |
| `POST` | `/player/member/purchase` | 购买/续费 `{planId, operationId}` |

### 店长

- 「会员」页：启用会员，查看会员卡和效果，维护售卖方案。
- 玩家页「发放资产」：选择会员卡后，表单切换为会员方案，可开通/续费；已是会员时可取消。
- 资源组/资源编辑：分别选择普通方案和会员方案。

接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/staff/member` | 会员设置与方案 |
| `PUT` | `/staff/member` | 保存 `{enabled}` |
| `POST` | `/staff/member/plans` | 新增方案 `{name, assetCode, price, durationDays}` |
| `PUT` | `/staff/member/plans/:planId` | 修改方案 |
| `POST` | `/staff/member/plans/:planId/archive` | 下架 |
| `POST` | `/staff/member/plans/:planId/restore` | 重新上架 |
| `GET` | `/staff/players/:playerId/member` | 玩家会员状态 |
| `POST` | `/staff/players/:playerId/member/grant` | 按方案发放/续费 `{planId}` |
| `POST` | `/staff/players/:playerId/member/revoke` | 取消会员 |

读接口允许 viewer，写接口要求 manager/owner。

## 6. 已知边界

- 不做自动续费、到期提醒、按比例退款。
- 会员中途开通/到期不会切换正在进行的 session；需要新方案时先停再开。
- 会员卡效果在结账时按当前持卡状态判断；已结账账单不回算。
- 会员卡优惠与普通资产优惠一样参与现有结算顺序；多张会员卡同时有效时优惠可能叠加。
- 会员方案是计费规则，不能替代会员卡；没有会员卡就不会被识别为会员。

## 7. 实现位置

- `packages/core/src/member.ts`：会员卡类型、方案/状态类型、资源方案设置键。
- `packages/application/src/member-service.ts`：方案、购买、发放、取消、状态。
- `packages/server/src/resources/billing.ts`：普通/会员方案解析。
- `packages/server/src/resources/member-plans.ts`：资源组/资源的会员方案映射（`app_settings`）。
- `packages/server/src/routes/shops/member.ts`：店长会员接口。
- `packages/prism-web/src/ui/merchant/Member.tsx`：商户会员页。
- `packages/prism-web/src/ui/MemberCard.tsx`：玩家会员卡/购买。

测试见 `packages/application/test/member.test.ts`、`packages/server/test/member-resource-plans.test.ts` 和 `packages/server/test/member-routes.test.ts`。
