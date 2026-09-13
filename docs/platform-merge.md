# PRiSM platform merge

The unified platform lives in `packages/platform` (Worker) and `packages/prism-web` (React). The existing runtime and Flutter merchant dashboard remain available during migration. HINATA Go and its App Clip use device links for the complete native in-store flow. Account settings and merchant management belong to Web.

## API

Canonical JSON APIs use `/api/v1`, successful `{ data: ... }` responses and failed `{ error: { code, message, details? } }` responses with HTTP status codes. Redirects, association documents and binary assets are not wrapped. `/rpc` and the imported platform's unversioned `/api` are temporary compatibility adapters. New clients must use v1. Hosted billing routes are scoped under `/api/v1/shops/:shopCode/{player,staff,integration}`. The platform resolves the shop and identity before constructing billing dependencies; a body-supplied player or shop ID is not authentication.

## Storage and migration

All 29 billing tables use `shop_id`. Primary/unique keys, foreign keys, reads, writes, reports and operation leases are scoped. Standalone compatibility defaults to the explicit `legacy` scope. Hosted code must pass the authorized shop ID. D1 and SQLite use the same schema and repository implementation. Migration 0016 rebuilds tables and copies existing rows into `legacy`; 0017 adds global account/platform tables without resetting existing account data. Existing ArcadeLink auth `sessions` must be imported as `auth_sessions`.

Stop old writers and take a backup before production migration. Do not apply migration 0017 to an ArcadeLink database: the destination is a migrated PRiSM database. Import ArcadeLink rows separately with explicit columns, preserving IDs. Existing ArcadeLink shops retain machine location checks; new shops default all optional location checks off. Store mapping and staff-account mapping must be explicit. Do not merge by nickname or QQ across shops.

Player account and QQ memberships are per shop. Codes expire after five minutes, are stored as hashes and consumed atomically. Existing-only registration is the default. Pure card shops require no QQ. The three location flags independently protect entry, checkout and player device operations. When required, Bots direct players to Web rather than bypassing the location gate.

## Receiver compatibility

The deployed receiver project is `hinata-aimeio-rs`. Its remote backend accepts E2EE V1/V2 card messages. KEY_PRESS requires encryption, expiration, a valid key and count (1–20); its replay cache uses message IDs. HTTP relay acceptance is not physical card-read confirmation. Keep current receiver protocol and identifiers.

## Validation record (2026-09-12)

- 427 Bun tests, TypeScript checks, 47 Koishi tests, Web build and Wrangler dry-run passed. Transactional checkout, shop isolation, QQ proof, current staff membership, optional location, idempotent money operations and concurrent ticket claiming have runnable regression checks.
- Production exports were obtained read-only via Wrangler on 2026-09-11, and remain outside Git in the private local Codex directory. Canonical content hashes match for all 29 billing tables and all 12 ArcadeLink tables after the explicitly mapped local rehearsal; no foreign-key errors. 11 global accounts and 6 shops were preserved. This local mapping is a rehearsal, not an approved production store mapping.
- Browser acceptance used only synthetic local data: mobile player list, recharge (100 → 125), checkout and removal from the in-shop list, pricing edit, asset creation, and location settings save. Physical receiver delivery, production OAuth and real iPhone NFC/App Clip invocation still require on-site acceptance after deployment configuration.

## Merchant Web

The merchant workspace is `/merchant/:shopCode/:section?`, with one navigation for devices, players currently in the store, players, pricing, assets, records and settings. Billing tabs appear only when billing is enabled. Legacy `/billing` URLs redirect into this workspace. Creating a store starts with an operating-mode choice; billing setup creates the paid/gift balance definitions, default admission rule and a QQ Bot credential in the same D1 batch as the store. The credential is shown once. Advanced time rules use a 24-hour SVG ring backed by the existing pricing-timeline preview endpoint, including priorities, dates, time zones and caps.

A device is an independent identity and QR/NFC destination. It may have **zero**, one or several capabilities: one Home Assistant power binding, one HINATA IO binding and a TTLock lock ID. No binding is mandatory, and an empty device has an empty player operation area. Existing `machines` IDs and `/t/:shopCode/:publicId` links are retained by migration 0018; `kind` is only a compatibility display hint, never a capability constraint. Both HA connection secrets and IO URLs/passwords are encrypted at rest using the existing platform key. Old PRiSM connection entries can be selected inside the device editor; their secrets are copied server-side into the chosen logical device. Store owners choose the pairing; devices are never merged just because their names are similar. The legacy settings arrays remain as import sources for migration, rather than a second operational device registry in the Web UI.

An entrance QR opens the same device session as a machine QR. Bound TTLock doors require the store QQ membership even without billing. If billing is enabled, explicit admission consent precedes entry and password creation; an existing entry is reused. The TTLock password is valid for three minutes. Losing the door response never silently stops billing. A machine with HA shows power-on while off and coins/cards after HA confirms on; a failed/unknown HA state still allows card and coin use. Only an explicit off state blocks those actions. HA works without billing. The store's check-in location flag applies to door actions, and its machine flag applies to power/coin/card actions. Current HINATA Go/App Clip render device capabilities, QQ verification, admission, door codes, power/cards/coins, balances, redemption, history and checkout natively, alongside the Web experience. They ignore `webOnly` for flow selection; that field remains a compatibility hint for older app releases. Account settings remain on Web and no new store dashboard entry is added to the native app.

All platform device actions use the logical ID in `player_operations` and `device_commands`, including card-only stores, and the merchant device dialog shows the same history. Staff power-off requires current store access. Player power-off is rejected. Power, coin and door requests carry operation IDs, and card requests can repeat within the ticket lifetime, each with a distinct audit operation. Coin cooldown is claimed atomically per logical device, shared by manual and automatic coin requests. The optional per-device `coinAfterSwipe` flag defaults off. When enabled, the player page retains the original card picker layout and hides the standalone coin button. After a successful card relay response, the server sends one encrypted KEY_PRESS with a distinct message ID and child command record. Card failure never sends a coin. Cooldown, coin rejection and unknown coin delivery are returned separately from the successful swipe; swipe results remain on the device screen, and neither command is retried automatically. HINATA IO coins require a connection password and a key code from 1 to 65535; legacy plaintext card-only devices remain supported. This flow confirms relay acceptance, not the physical game reading the card. Unknown relay results remain pending and are not retried automatically. Legacy platform player/staff/Bot device-command proxies direct users to device pages, preventing the old HA/IO registry from bypassing logical device gates. Standalone billing runtime compatibility endpoints remain separate during migration.

The new navigation deliberately omits business items/orders per the product decision on 2026-09-11. Existing data and compatibility APIs remain; no records are deleted by this UI simplification. Copy is kept to labels and actionable errors. Read-only staff cannot mutate billing or retrieve device secrets, and removed shop members lose billing access even if their historical staff mapping remains. The old Flutter merchant dashboard remains available as a compatibility client during deployment migration.

`bun run dev:platform` serves the unified Worker and built React assets locally. `bun run check:platform` builds and runs Wrangler with `--dry-run`. `wrangler.platform.jsonc` is intentionally a local template: set production D1/KV bindings and the preserved public origin before an explicitly approved cutover.

## Local migration rehearsal

Convert read-only SQL exports into private SQLite snapshot files before using the merger. Keep these files, the manifest and its output outside Git. The manifest maps every single-store billing database to an existing ArcadeLink `shops.id`, and can map historical staff IDs to existing global shop members:

```json
{
  "arcadelink": "arcadelink-source.sqlite",
  "billing": [{ "database": "prism-source.sqlite", "shopId": "existing-shop-uuid" }],
  "staffAccounts": [{ "shopId": "existing-shop-uuid", "userId": "global-user-uuid", "staffId": "existing-staff-id" }]
}
```

Paths are relative to the manifest. `staffAccounts` can be empty; global shop owners are then provisioned on first access. Run `python3 scripts/merge-platform.py /private/manifest.json /private/new-platform.sqlite`. The output must not exist. The command opens source snapshots read-only, verifies schemas and every source table, checks foreign keys, writes migration tracking for 0016/0017 and creates the destination with private permissions. Imported shops keep billing disabled until an owner sets the Bot, entry pricing and optional location policies. Existing currency codes, identities, operation history and balances are preserved.

The standalone SQLite server automatically backs up and transactionally upgrades a pre-0016 local database on startup. Embedded runtime users must explicitly migrate an old database before schema initialization. For a production cutover, stop all old writers, take fresh snapshots, review actual store/staff mappings, rehearse again and restore the verified result into a new D1 database. Preserve the original databases for rollback; do not overwrite either source. Configure the existing encrypted-URL key, session secret, MuNET credentials, passkey origin/RP ID and native association IDs before switching the `link.neri.moe` route. New hosted billing APIs coexist with the standalone legacy adapters; legacy billing clients continue to use their old single-store deployment until migrated.

## Operation guarantees

Player checkout/redeem/device commands and merchant money/device POSTs carry an `operationId`. Retries with the same ID and payload replay the recorded result; changed payloads conflict. The Web retains pending IDs in session storage through lost responses and reloads. Unknown results remain pending for operator reconciliation. Entry is deduplicated across Web and Bot. Imported active sessions also count as entry when their pricing IDs match the configured ordinary entry rules, without rewriting historical labels.

Machine ticket claiming and its pending operation/audit rows commit in one D1 batch before relay delivery. Each ticket can send once; relay acceptance is recorded as sent, and uncertain delivery is not automatically retried. Neither swipe failure nor closing a client checks out the billing session. Player checkout fails atomically on insufficient funds and continues timing. Used shops and machines cannot be deleted through the new UI/API; machines can be disabled.

For a synthetic merchant preview: `bun run build:web`, then `bun packages/platform/scripts/preview.ts`. Open `http://127.0.0.1:8790/merchant/demo`. This process binds only to loopback, seeds its own in-memory D1 and session, and has no real device URLs or production credentials.


The local preview includes `/t/demo/entrance`, `/t/demo/maimai`, `/t/demo/chunithm`, `/t/demo/card-only` and `/t/demo/empty`. Its TTLock, HA and IO endpoints are simulations under `.preview.invalid`; outbound physical-device requests to other hosts are rejected. Restarting the preview resets the fixtures. Production snapshot rehearsal applies migration 0018 after row-hash verification of the original columns, keeping the source snapshots read-only.

The preview also includes a billing-disabled store at `/merchant/lite`, with `/t/lite/lite-auto` (automatic coin), `/t/lite/lite-manual`, `/t/lite/lite-power` (initially off), `/t/lite/lite-unknown` (unavailable HA), `/t/lite/lite-entrance` and `/t/lite/lite-empty`. Its IO mock decrypts E2EE V2 messages and validates single-coin commands. The store has no pricing or currency assets. Nonbilling regression checks cover plaintext cards, encrypted card/coin ordering, shared cooldown, one-time ticket consumption across both login routes, no automatic coin on failed/unknown card delivery, partial coin results and no created billing sessions or QQ membership.

Nonbilling TTLock acceptance also verifies that QQ is still required, the password is issued without admission consent or billing, replay does not create a second password, and no session or currency assets are created. Player-layout browser checks use 390×844 and confirm that unknown HA state still renders the original card picker.

## Player flow revision — 2026-09-12

The player operation surface is QR/NFC → static `/t/:shop/:device` link → expiring `/m?ticket=…` session. Player shop/device lists and all UI links that mint another device session have been removed. Native clients no longer renew expired tickets. `/t/:shop` no longer opens a store dashboard; public player device-list endpoints no longer return operation destinations. Public static links are not physical-presence proof; stores can additionally require geolocation for entry, machine actions and checkout.

The top-right account name opens logout and, for billed shops, Bill / Redeem / History / Wallet. Each opens a focused dialog or native sheet. Bill loads a preview before checkout. The menu remains available after device ticket consumption so users can settle. There is no combined spending page or bottom spending link. QQ codes generate automatically on the binding gate; only the group command and expiry appear, without Bot contact or enrollment copy. Any configured device can show admission consent; non-door admission requires its ticket, matching shop and explicit consent. Door admission additionally retrieves a temporary password, with a new-password action remaining available.

Migration **0019_ticket_coin.sql** adds the atomic per-ticket coin claim. A manual coin ticket allows one coin; afterward the disabled button says “已投币”. Card delivery consumes the ticket for every further device action, whether accepted, failed or uncertain. Automatic coin is server-only on auto-enabled devices, follows accepted card delivery, and claims the same per-ticket coin slot. Staff operations retain the existing per-device cooldown. Unknown device actions expire the ticket and preserve pending command records. Power requests use button progress; no action notices are placed above the controls.

Player `pricingSchedule` resolves each selected calendar date through the existing billing timeline builders, including weekdays, priorities, specific dates, absolute date ranges, cross-midnight rules and applicable global caps. This remains an API compatibility view; player clients now display the enabled plans directly with their complete rule periods, conditions, rates, grace and caps. The source review used the private Wrangler production export from 2026-09-11 (weekday overrides, dated New Year promotion and Spring Festival date range), plus the older `mmw_prism.sql` daytime/nighttime rules. Preview data reproduces those rule structures using synthetic records. No production players or credentials are included in the preview or committed.

The account control uses the native iOS 26 glass button and system Menu in App Clip, preserving its existing provider-notice top clearance. Flutter and Web use matching capsule account controls with translucent/blurred surfaces and rounded popup menus.

Player device content keeps 140px of top spacing plus the safe area, matching Flutter and App Clip. The account menu sits independently at the top right, 8px below the safe area. Player task headings use the 32px bold card-selection style. Web dialogs use the existing dialog title style (`text-lg font-semibold`), separate from device-page headings. Native sheets follow their platform title styles.

The player admission view reads `entryPricing`, filtered centrally using the billing engine’s timeline for the current local date. Only rules effective during that date are returned, including overnight carryover from the preceding date; fully overridden, inactive and out-of-date rules are omitted. Rules are deduplicated by ID and retain their complete original overnight time ranges rather than midnight-clipped timeline segments. Empty plans are omitted; fixed entry fees remain. Display order follows descending rule priority. It shows weekday/date conditions and complete overnight periods (for example 22:00–next day 10:00), with no date picker or visible time zone. Absolute date ranges are formatted by the API in the plan time zone and labeled as continuous periods when there is no recurring daily window. The daily `pricingSchedule` response remains available for existing callers. Player task and sheet headings are centered; sheet close controls stay at the right.

Player checkout actions stay at the bottom of the bill dialog/sheet, outside the scrolling receipt, on Web, Flutter and App Clip. The Web dialog uses a fixed header and footer around a bounded scrolling body, preserving checkout access on long bills and small screens. The App Clip's white glass close button uses a 44-point circle and 18-point top/trailing inset, concentric with the sheet's 40-point corner radius; the system glass background is preserved.

Player task typography follows platform conventions: Swift uses Dynamic Type `.title2`; Web approximates its default appearance with a 1.375rem regular system-font heading. Flutter uses its own Material hierarchy, with larger 88-point-minimum card action rows and 22/14 text. The approved shop information/banner card remains unchanged.

YG rehearsal (2026-09-12): uses the existing September 11 prism-yg prism-next snapshot, without further remote D1 operations. Pricing and asset definitions match the source exactly. An isolated tenant copy and new test players exercise QQ binding, device admission, password refresh, power, coin/card (the historical rehearsal used single-use controls), automatic coin, redemption, checkout replay and insufficient balance. The 61-minute test visit costs 8 with the source 5-minute grace. Source data is unchanged; hardware and QQ delivery are simulated. Screenshot fixtures replay those API responses using the actual three platform views.

The separate prism-neo importer preserves fractional asset quantities, with a regression test; prism-neo data is not used for the YG rehearsal.

Location policy is now one `locationEnabled` setting, independent of billing. For compatibility, legacy location flags are accepted, normalized with OR, stored together, and returned as synchronized aliases. Entry and device actions require an inside fix; checkout requires an outside fix beyond the existing accuracy allowance. Missing or low-accuracy fixes do not permit checkout. Web, Flutter and App Clip prefer the unified field. Merchant forms no longer inherit player surface overrides; bound QQ identities are displayed without an extra binding form.

QQ verification remains scoped to each shop. The global login account only claims that shop’s existing QQ profile after verification; it does not transfer verification across shops. Imported profiles keep balances and history, and no automatic global QQ merging is performed. Bot framework filters configured by the merchant determine where the binding command is available; neither the API nor the plugin maintains a group allowlist or a direct-message restriction. The plugin uses the actual QQ sender.

Devices can keep HINATA IO card login without enabling coin output: coin key 0 disables coin capability and hides coin actions; card remains available. Successful card login briefly shows completion before allowing another swipe across Web, Flutter and App Clip. Only ticket timeout uses the expired-session page.

Merchant coin configuration keeps the keycode input and automatic-coin checkbox visible when HINATA IO is selected. They are disabled without a connection password. An empty keycode disables coin output (stored as 0); there is no separate enable toggle. The keycode field links to Microsoft Virtual-Key Codes. Existing passwords are retained when the password field is left empty.

Merchant settings use consistent bounded sections and a single member list with inline billing permissions. The workspace caption, player-view link, timezone labels, Bot contact field and device QR caption are removed. Internal store timezone remains unchanged when saving settings. Bot contact is no longer a billing setup prerequisite. Door devices describe only door-code retrieval; admission remains available through any scanned device session.

## Mahjong devices and migration acceptance

A logical device may enable a Mahjong table with capacity 2–8 (default 4) and pricing IDs. Web, Flutter and App Clip require a QR/NFC ticket for join/leave. QQ proof is required; billed stores require admission. Waiting seats persist without table billing. The capacity-reaching join creates all waiting sessions at the same instant in a D1 batch transaction. Replacements at a playing table start immediately. Leaving closes only that player's table session; ordinary admission stays active and checkout includes the closed session. Stale seats after checkout or staff closure do not occupy capacity. Configuration cannot change while seats remain.

Migration 0020 adds table configuration and seats. The snapshot merger now applies all post-platform migrations in order, including 0019/0020. ArcadeLink user/shop/card/device IDs and encrypted values remain intact; sessions become auth_sessions. Sources stay read-only and content digests/foreign keys are checked. Existing ArcadeLink owners need no new account. Other billing sources require an explicit target shop/owner mapping. Retain repositories and databases for rollback until production acceptance.

Bot acceptance includes QQ binding, roster, billing and legacy device commands. A valid shop Integration token authorizes automation without player GPS or QR tickets; shop isolation, player status, entry requirements, coin cooldown and staff-command checks still apply. Web/native player endpoints retain their GPS and ticket requirements. See `bot-comparison-2026-09-13.md` for the real Koishi differential run.

## Cloudflare beta deployment

The `prism-link-beta` branch deploys to the separate `prism-link-beta` Worker.
Workers Builds uses repository root `/`, build command `bun run build:web`, and
deploy command `bun run deploy:beta`. Disable non-production branch builds.
Deployment runs `scripts/generate-wrangler-config.ts --platform`, reading
build variables documented in `.env.example`. The generated
`wrangler.generated.jsonc` is ignored by Git. Resource IDs, domains and client
identifiers belong in Cloudflare Workers Builds variables, not tracked files.
Import the verified merged snapshot into its dedicated D1 database before the
first deployment; subsequent builds apply outstanding migrations. Existing
single-store Workers keep their current branches and deployment configuration.

Set runtime secrets `MUNET_CLIENT_SECRET` and the original ArcadeLink
`URL_ENCRYPTION_KEY` in Cloudflare. Do not rotate the latter during migration: it
protects existing device URLs and stored OAuth credentials. Register the beta
OAuth callback with MuNET before testing sign-in.

Koishi `baseUrl` is the deployed Worker origin (no `/api`
suffix), with the shop's `shopCode` and `integrationToken`. Binding and roster
requests use `/api/v1/shops/{shopCode}/integration/...`.

Native PRiSM clients use the App Clip identifier `moe.neri.hinatago.prism` and OAuth callback scheme `hinata-prism-auth`. The Apple association response and native authentication endpoint share these identifiers with HINATA Go.


### Player account reads and active billing

Account menus show a compact billing indicator based on the active session, scoped to the signed-in user and shop. It clears after successful checkout. Bill loads summary plus preview; Wallet and History each load their batch only when opened. Neither collection is required for device polling. Wallet currently returns holdings and up to 100 ledger entries in one SQL query; history returns up to 100 joined session/settlement rows in one query, with no per-row requests.

Web API reads bypass the response cache and retry a transport failure once for GET and checkout preview only. Device actions and financial mutations are not automatically resent. Sheet failures stay inline with a retry control. Device polling does not overlap itself or run reads in hidden tabs.

Device tickets remain resolvable after card, coin, power or door attempts until their original expiry. Card sends are repeatable within a ticket. Manual and automatic coin sends share the existing atomic per-device cooldown lock; manual cooldown attempts return COIN_COOLDOWN (429), while automatic coin skips without failing the card send. IO transport/configuration failures return DEVICE_UNAVAILABLE with an actionable device message. Failed commands do not invalidate the whole ticket. The UI remains on the device screen, keeps card/coin controls available and uses the initial loading indicator while device/power information loads.

If the card was sent but automatic coin delivery fails, clients show the coin failure without navigating away or blocking another card send. Cooldown skips are not device failures.


Merchant Players requests only the batched player listing and uses its active/unpaid flags; it does not calculate venue checkout previews. The on-site page requests only live players, whose response includes identity and balance fields. Live-player queries return immediately when no sessions are active/unpaid, restrict wallet/player reads to the relevant IDs, and calculate previews with at most four concurrent players. The original pricing engine and checkout totals remain authoritative; unpaid closed sessions remain available for settlement.

### 在店计费时段与分组

在店页参考原 Flutter 管理面板，使用玩家列表与账单双栏布局，小屏上下排列。列表显示时长、应付与状态；账单按会话展示金额，展开查看实际计费时段、费用及封顶。支持按状态或进行中的方案组合分组，不重复计数。文案使用“账单”“应付”“余额”。复用 live-players 明细，不增加逐人请求；停止与结账复用既有接口。完整计算顺序见 [当前计费说明](billing-flow.md)。

在店列表的入场时间、账单中的实际开始／停止时间和封顶窗口时间使用更醒目的正文大小、半粗体和等宽数字；持续时长与规则时段保留次要层级。窄屏允许时间范围换行。

在店信息优先级调整：每位玩家的姓名与状态下方并列显示入场钟点、累计时长、应付金额，均为主要数字；日期、余额、计费项数为次要信息。账单顶部采用相同顺序，并放大会话及明细中的持续时长。

### Bot 兼容检查（2026-09-13）

Koishi 分支已修正 QQ 绑定对 onebot 平台的误拒绝，以及查人时麻将等待席位未计入总人数的问题；混合音游与麻将名单按玩家 ID 去重。插件 48 项测试与 TypeScript 构建通过，平台已有 QQ 绑定隔离与麻将名单接口测试。检查 npm 实际发布包 0.1.38，尚不包含 prism.bind 与 shopCode 路由支持，因此更新后端不能替代升级 Bot 插件。源码测试不代表实际 QQ 群、Bot 框架过滤与运行版本已验收；本次不发布 npm。新平台配置为 baseUrl=https://link-beta.neri.moe，shopCode 为店铺编号，integrationToken 为对应店铺的 Integration 令牌。

Mahjong player controls group the title/status and occupancy count in one header, with a two-column roster including empty seats and a personal-seat marker. Full tables show a quiet status instead of a disabled join action. Shop banners remain unchanged.

麻将人数不足时统一显示“等待玩家”（Waiting for players），保留两列座位布局。
