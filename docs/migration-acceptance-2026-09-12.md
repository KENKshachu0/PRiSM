# 本地迁移验收 · 2026-09-12

使用之前导出的 ArcadeLink 与 prism-yg 完整备份，未重新访问生产 D1。输出写入新的私有 SQLite，未改动源备份及线上数据。当前映射仅用于本地演练，不是正式店铺归属。

- ArcadeLink：11 个账号、6 个店铺、6 条成员关系、48 张卡片、7 台设备、12 条 Passkey、25 条登录会话、82 条刷卡记录；12 个源表逐列内容摘要匹配。
- prism-yg：29 个源表逐列内容摘要匹配，涵盖玩家、QQ 身份、资产、计费方案和历史账务。
- 完整执行 0016–0020；迁移后再次校验源字段摘要、外键和 SQLite integrity_check，均通过。
- 使用同一 YG 备份映射到两个不同店铺，验证重叠玩家/账务 ID 的租户隔离；这是冲突压力测试，不代表另一个真实店铺已完成验收。
- ArcadeLink 原有 45 个 HTTP 路由均有新平台对应路由；旧 /api 路径保留兼容入口。保留原域名、加密密钥与 OAuth/Passkey 配置仍是生产切换条件。
- 麻将：入场资格、二维码有效期、等待不计费、凑齐同时计费、并发抢座、故障事务回滚、下桌幂等、补位和独立结账有 D1 回归检查。Bot 查人覆盖持久化等待座位；Flutter/App Clip 使用原生操作界面。

## 尚未完成的生产验收

没有找到 prism-api / prism-fsw 的完整本地生产备份，不能声明它们的数据已验收。需要确认每份计费数据对应的店铺和店主；有既存 ArcadeLink 账号与店铺的，直接保留，无需重新注册。无既存账号或店铺的，可以在统一平台创建后提供编号再映射。旧 PRiSM 店内 QQ 档案不会被自动改成全局账号。

当前没有执行生产部署或流量切换。保留 ArcadeLink 仓库、旧数据库和部署以便回滚；正式迁移并验收后可将旧仓库归档。若现有系统仍有写入，旧备份不能直接视为切换时的最新账务数据。

### prism-api beta import

A fresh authorized prism-api snapshot exposed an ordering issue in migration
0016: assets referencing a pricing effect must be copied after their pricing
effects. The migration now respects that dependency with foreign keys enabled;
a populated regression test covers it. Source snapshots are never modified.

The beta copy imports 1,358 prism-api players and 12,072 billing sessions into
shop code `prism-api`, owned by MuNET `neri`. Original ArcadeLink ownership is
preserved; its six shops, 11 accounts, 48 cards and seven devices remain intact.
The target has 49 tables. Large shop banners are imported in bounded chunks to
respect D1's statement-size limit, with exact content checked locally.

Beta database: `prism-link-beta`, separate from all original databases.
The original encryption key and OAuth secret are copied through an expiring,
authenticated RSA-OAEP transfer, then the temporary source endpoint is removed.
The beta OAuth callback is added to the existing MuNET client without rotating
its secret. Existing passkeys remain tied to the original relying-party domain;
use MuNET to sign in on the beta domain.

The nine original HA entries remain in the merged `app_settings` registry until
the explicit logical-device import is run. `scripts/import-legacy-devices.ts`
uses their existing connection configuration, encrypts it with the preserved
URL key, creates deterministic logical devices and maps old command/state
references. Three existing mahjong tables and 12 occupied seats are reconstructed
from active labeled sessions as a separate acceptance step; their session IDs,
start times, pricing and amounts are preserved. Mahjong metadata links those
sessions to the new logical devices. The 18 ordinary active entry sessions
continue to match the original standard pricing rule; global caps remain
automatic. Existing ArcadeLink `/t/:shopCode/:publicId` links reach the Worker
before SPA asset fallback and continue to create one-time tickets.
