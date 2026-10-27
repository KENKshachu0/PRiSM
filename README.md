# PRiSM Next

PRiSM Next is a self-service venue operations core for time-billed game rooms, rhythm-game nests, arcades, and similar unattended spaces. It replaces the old split backend/Bot flow with a runtime-independent TypeScript core, a Hono API, a Staff Web console, Integration clients for bots and self-service entry, and Machine WebSocket delivery for game-machine software.

The default operating model is one deployment per store. A store can deploy the API and Staff Web console to Cloudflare Workers + D1, or run the same API locally with Bun + SQLite. Bots, self-service entry surfaces, and machine software remain on store-controlled machines.

## Status

The current implementation covers the planned replacement scope:

- Player identity, multiple flat active billing sessions per player, player-level checkout preview/confirm, explicit session stop, and staff checkout override.
- Asset catalog, holdings, transactions, immutable ledger entries, paid/free currency priority, active/expiry windows, grants, adjustments, revocation, hidden player assets, and archive semantics for referenced definitions.
- CDK/present redemption with active/expiry windows, max use count, and once-per-player behavior.
- Priority time pricing with weekdays, specific dates, absolute ranges, cross-day ranges matched by rule start day, rounding grace, caps, paid-history cap behavior, and a Staff Web visual day timeline plus rule-impact summary.
- Persisted fixed-charge pricing and store-managed business items for non-time products such as entry tickets, event fees, reservations, room packages, and service charges, plus runtime plugin registration that can read active Staff Web business items for more complex pricing and asset-effect products.
- Door, power, coin, and scan command authorization, coin cooldown, command queue, ACK/expiry, device state reporting, and audit views.
- React admin and player UI in `packages/prism-web`, including store creation, devices, player-first live operations, front desk cashier, checkout, pricing, assets, permissions, settings and reports.
- Shared RPC contract for Player, Staff, Integration, and Machine clients.
- Koishi Bot package, bot-client helpers, and Machine WebSocket delivery.
- Tested migration plan and SQL importer from `prism-neo` export-shaped data.

Player Web supports device QR/NFC flows and the shop page for bills, redemption, history and wallets.

## Repository Layout

```text
packages/core            Pure domain rules.
packages/application     Use-case services and adapter-neutral query contracts.
packages/storage-sql     SQLite/D1 schema, write repositories, and SQL read models.
packages/adapter-sqlite  Bun SQLite adapter.
packages/adapter-d1      Cloudflare D1 adapter.
packages/server          Unified server API, multi-tenant & legacy routes, hardware drivers, Worker & Bun entrypoints.
packages/prism-web       React admin and player UI, built with Vite.
packages/koishi-plugin   Koishi plugin (git submodule, standalone repo koishi-plugin-prism)
packages/migration       prism-neo conversion plan and importer.
migrations               D1 migration SQL.
docs                     Architecture, deployment, API, integration, and migration docs.
```

## Quick Start: Local Platform

Install dependencies and initialize the remaining Bot submodules when needed:

```bash
bun install
git submodule update --init --recursive
bun run dev:all
```

`dev:all` builds React assets, generates local platform configuration, applies local D1 migrations, and starts the platform Worker and React Vite server. If an AstrBot workspace is present, it also starts that optional runner.

- API health: `http://127.0.0.1:8787/api/v1/health`
- React management: `http://127.0.0.1:5173/merchant`
- Player shop page: `http://127.0.0.1:5173/t/:shopCode`

Use `PORT` and `WEB_PORT` to change ports; the runner updates the Vite proxy and allowed origins together. Configure MuNET OAuth credentials for real sign-in. Local D1 state is stored under the ignored `.wrangler` directory.

`bun run dev:local` remains available for the standalone Bun + SQLite API and regression/integration work. It defaults to `./prism.sqlite`, configurable through `PRISM_SQLITE_PATH`; it does not serve a separate management UI. Its `/admin` page explains how to start the React platform.

## Quick Start: Cloudflare

Create a D1 database with `bun run db:create:d1`, then configure `.env` from `.env.example`. Unified platform deployment requires `D1_DATABASE_ID`, `CLOUDFLARE_ACCOUNT_ID`, `APP_ORIGIN`, `MUNET_CLIENT_ID` and `APPLE_TEAM_ID`. Keep runtime secrets such as OAuth client secrets, session secrets and URL encryption keys in Cloudflare Secrets.

```bash
bun run deploy:beta
```

This builds `packages/prism-web/dist`, generates the platform configuration, applies remote D1 migrations, and deploys the Worker with React assets and backend version metadata. Migration failures stop the deployment. Open `/merchant` on the deployed origin, sign in and create or choose a shop; its display zone follows its location.

For Cloudflare Workers Builds:

- Build command: `bun run build:web && bun run scripts/generate-wrangler-config.ts --platform`
- Deploy command: `bun run deploy:beta`
- Non-production branch deploy command: `bunx wrangler versions upload`

Each project owns its deployment variables. Generated Wrangler configuration and local data remain ignored. `bun run deploy:worker` builds React assets and deploys the unified Worker via `wrangler.jsonc`. See [docs/deployment.md](docs/deployment.md) for configuration and migration details.

## Auth Model

The React platform signs users in through MuNET/passkeys and checks shop membership and billing roles. Owners can require any verified bot-platform identity or allow Web-only admission. Koishi uses the actual adapter identifier and user ID; Settings includes an explicit identifier conversion preview, with no automatic legacy renaming. The standalone API retains its OOBE-created staff accounts and RPC credentials for compatibility:

- Staff calls: log in through `/rpc/admin/login`; use the returned session token.
- Player Web calls: log in through `/rpc/player-auth/login/by-identity`; use the returned player session token.
- Bot/self-service entry calls: `Authorization: Bearer <integration-api-token>` and structured external identities.
- HINATA IO machines: connect directly to `/io/ws` with the per-device token issued on the device board (`Authorization: Bearer <deviceToken>`).

The owner can create manager/viewer/owner staff users, disable staff accounts, and reset staff passwords from Staff Web. Staff users are archived by status rather than physically deleted, so historical audit references stay readable. Staff-created asset definitions, presents, and pricing configs also use archive semantics; archived catalog records stay visible but must be restored before they can be edited or reused. System base assets created by OOBE cannot be archived because they anchor settlement and migration.

## Common Commands

```bash
bun run dev:local
bun run dev:worker
bun run deploy:worker
bun run db:migrate:local
bun run db:migrate:remote
bun run migration:import-json --input ./exports/prism-neo-export.json --sqlite ./data/prism-next-staging.sqlite
bun run typecheck
bun test
bun run dev:all
bun run build:web
bun run check:server
bun run check:platform
bun run deploy:beta
bun run version:bump patch
```

The root `package.json` owns the release SemVer. `bun run version:bump patch|minor|major` updates it without requiring another UI repository; Worker deployment injects that version and the Git revision.

## React management

`packages/prism-web` is the sole management client. The live operations screen is player-first: each player appears once, with an adjacent bill showing sessions, charged periods, fees and caps. A staff member can stop one session, then settle every unpaid session for that player through unified checkout. Pricing keeps weekday/specific-date/date-range rule forms, and its editor converts local clocks to UTC at the API boundary.

## Documentation

- [当前工作区开发环境](docs/dev-environment.md)
- [单方案未覆盖全天的计费验证](docs/billing-gap-analysis.md)
- [截图中的入场失败与时区](docs/pricing-timezone-analysis.md)
- [UTC 业务时间与 UI 展示时间](docs/utc-time-contract.md)
- [Architecture](docs/architecture.md)
- [API Reference](docs/api.md)
- [商户工作台的开店指引](docs/merchant-setup-guide.md)
- [快速创建计费](docs/billing-setup.md)
- [前台收银与 WebHID 读卡](docs/cashier.md)
- [资源与资源组](docs/resources.md)
- [计费状态编排：会话、依赖与冲突](docs/pricing-sessions.md)
- [卡片、占用与查人](docs/occupancy.md)
- [计费流程、封顶与账单显示](docs/billing-flow.md)
- [实时活动推送](docs/live-activity-push.md)
- [Deployment](docs/deployment.md)
- [Integrations And Machines](docs/integrations-and-machines.md)
- [Extension Guide](docs/extensions.md)
- [Money Precision](docs/money.md)
- [Migration From prism-neo](docs/migration-from-prism-neo.md)
- [Roadmap](docs/roadmap.md)

## Production Notes

Before using PRiSM Next in a real store, run a migration dry run against exported old data, configure the store in React management, store Integration/Machine tokens safely, test the actual machine software and facility gateway services, and verify settlement summary plus exported settlement-detail CSV against expected business rules.

SQLite databases, backups, migration exports, `.env` files, and generated Wrangler configs are intentionally ignored. Never force-add files under `exports/`, `*.sqlite*`, `mmw_prism.sql`, `.env*`, or `wrangler.generated.jsonc`; they can contain store identities, password hashes, API-token hashes, and transaction history.
