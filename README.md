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
- Flutter `prism_dashboard` admin console, including OOBE/login, Chinese store-owner workflows, player-first live operations, flat session details, explicit session stop, player-level checkout, visual pricing controls, asset/present/archive management, service items, staff permissions, settings, credentials, player, report, and device views.
- Shared RPC contract for Player, Staff, Integration, and Machine clients.
- Koishi Bot package, bot-client helpers, and Machine WebSocket delivery.
- Tested migration plan and SQL importer from `prism-neo` export-shaped data.

Player Web UI is intentionally not built yet; the `/rpc/player/*` API surface is reserved for it.

## Repository Layout

```text
packages/core            Pure domain rules.
packages/application     Use-case services and adapter-neutral query contracts.
packages/storage-sql     SQLite/D1 schema, write repositories, and SQL read models.
packages/adapter-sqlite  Bun SQLite adapter.
packages/adapter-d1      Cloudflare D1 adapter.
packages/server-hono     Thin Hono API, auth guards, response views, and Staff Web handoff.
packages/runtime         Local and Worker composition entrypoints and external adapters.
packages/prism-dashboard Flutter Web admin console named prism_dashboard (Git Submodule).
packages/admin-flutter   Legacy Flutter admin reference package.
packages/koishi-plugin   Koishi plugin (git submodule, standalone repo koishi-plugin-prism)
packages/migration       prism-neo conversion plan and importer.
migrations               D1 migration SQL.
docs                     Architecture, deployment, API, integration, and migration docs.
```

## Quick Start: Local SQLite

Clone the repository with submodules, or initialize them after cloning:

```bash
git submodule update --init --recursive
```

Install dependencies:

```bash
bun install
```

Run the API and Staff Web console locally:

```bash
bun run dev:local
```

Open:

- API health: `http://localhost:8787/health`
- Staff Web: `http://localhost:8787/admin`

The local server initializes the SQLite schema automatically and defaults to `./prism.sqlite`. Set `PRISM_SQLITE_PATH` only when you want the SQLite file on a specific persistent path.
Open `/admin` and complete the setup wizard. The wizard creates the owner account, store profile, base balance assets, and Integration/Machine API tokens. Player Web uses per-player sessions instead of a shared Player API token. The base assets stay stable as `type=currency, code=paid` and `type=currency, code=free`, while the wizard lets the store choose display names and units such as `余额` or `游戏点数`.

## Quick Start: Cloudflare

Create and configure a D1 database:

```bash
bun run db:create:d1
```

Put the returned `database_id` in a local `.env` as `D1_DATABASE_ID`. You can start from `.env.example`; set `D1_DATABASE_NAME` too if the database is not named `prism`. The checked-in `wrangler.jsonc` is intentionally account-neutral, while `bun run wrangler:config` generates the ignored deployment config for the current operator.

Deploy:

```bash
bun run deploy:worker
```

`deploy:worker` generates the per-deployer Wrangler config, applies all unapplied remote D1 migrations, and deploys the Worker. The migration step runs before upload; if it fails, the Worker is not deployed. For a local dry run, use `bun run db:migrate:local`.

After deployment, open `/admin` on the Worker URL and complete the setup wizard. Legacy Player/Staff/Bot/Agent/pricing/cooldown business environment variables are ignored for first boot; use Staff Web setup and credentials instead.

For Cloudflare Workers Builds connected to a GitHub fork, configure these build settings:

- Build command: `bun run wrangler:config`
- Deploy command: `bun run deploy:worker`
- Non-production branch deploy command: `bunx wrangler versions upload`
- Build variables: `D1_DATABASE_ID` (required), plus optional `WORKER_NAME`, `D1_DATABASE_NAME`, and `D1_PREVIEW_DATABASE_ID`

Each Cloudflare project owns its build-variable values, so multiple people can deploy the same public repository without committing personal Worker or D1 identifiers. The generated config also installs Wrangler's deployment-config redirect, allowing Cloudflare's default preview command to use the same per-project settings. The selected Workers Builds API token must be allowed to apply D1 migrations; use a user token with D1 Edit permission if the automatically generated token is rejected by the migration step.

See [docs/deployment.md](docs/deployment.md) for the full deployment checklist.

## Auth Model

Initial staff access uses the owner account created in `/admin`. Staff, player, integration, and machine traffic use separate credentials:

- Staff calls: log in through `/rpc/admin/login`; use the returned session token.
- Player Web calls: log in through `/rpc/player-auth/login/by-identity`; use the returned player session token.
- Bot/self-service entry calls: `Authorization: Bearer <integration-api-token>` and structured external identities.
- Machine software calls: connect to `/rpc/machine/ws` with `Authorization: Bearer <machine-api-token>`.

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
bun run prism-dashboard:analyze
bun run prism-dashboard:test
bun run prism-dashboard:build
bun run version:bump patch
```

后端与 `prism-dashboard` 共用根 `package.json` 的 SemVer。发布前使用 `bun run version:bump patch|minor|major` 自动增长版本并同步 Dashboard 的 `pubspec.yaml`；Worker 部署和 Dashboard 构建会自动附加各自当前 Git 短提交号，不在构建过程中改写版本文件。后端实际版本可从公开的 `GET /version` 查询。

## prism_dashboard

`packages/prism-dashboard` is the new Flutter Web management panel. Its Dart package name is `prism_dashboard`; the old `packages/admin-flutter` remains only as a reference while the new UI is verified.

The live operations screen is player-first: each player appears once, the preview column shows stay duration, and all active sessions under that player are shown as flat details. A staff member can stop one session without charging the player, then settle every unpaid session for that player through the unified checkout action. Pricing and configuration screens use pickers, segmented controls, switches, and steppers instead of raw time strings or developer payload fields, while the pricing lifecycle still covers weekday/specific-date/date-range rule forms.

## Documentation

- [Architecture](docs/architecture.md)
- [API Reference](docs/api.md)
- [Deployment](docs/deployment.md)
- [Integrations And Machines](docs/integrations-and-machines.md)
- [Extension Guide](docs/extensions.md)
- [Money Precision](docs/money.md)
- [Migration From prism-neo](docs/migration-from-prism-neo.md)
- [Production Checklist](docs/production-checklist.md)
- [Roadmap](docs/roadmap.md)
- [TDD Evidence](docs/tdd-evidence.md)

## Production Notes

Before using PRiSM Next in a real store, run a migration dry run against exported old data, complete OOBE in Staff Web, store the generated Integration/Machine tokens safely, test the actual machine software and facility gateway services, and verify settlement summary plus exported settlement-detail CSV against expected business rules.

SQLite databases, backups, migration exports, `.env` files, and generated Wrangler configs are intentionally ignored. Never force-add files under `exports/`, `*.sqlite*`, `mmw_prism.sql`, `.env*`, or `wrangler.generated.jsonc`; they can contain store identities, password hashes, API-token hashes, and transaction history.
