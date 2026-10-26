# Pre-merge server API regression contract

The compatibility baseline is `7fd7e7c` (the `main` parent of unified server PR #11).
This document is a regression inventory, not permission to deploy without full CI
and a real-device Live Activity check.

## Required public paths

- `/api/v1/shops/:shopCode/player/live-activity/bill` (`GET`, including
  `sessionId` to recover a previously paid visit)
- `/api/v1/shops/:shopCode/player/live-activity/register` (`POST`)
- `/api/v1/shops/:shopCode/player/live-activity/unregister` (`POST`)
- `/api/v1/shops/:shopCode/staff/settings` (`GET`, `PUT`)
- `/api/v1/shops/:shopCode/staff/api-tokens` (`GET`, `POST`)
- `/api/v1/shops/:shopCode/staff/api-tokens/:tokenId/revoke` (`POST`)
- `/api/v1/shops/:shopCode/staff/users` (`GET`, `POST`)
- `/api/v1/shops/:shopCode/staff/users/:staffUserId` (`PATCH`)
- `/api/v1/shops/:shopCode/staff/users/:staffUserId/password` (`POST`)
- `/api/v1/shops/:shopCode/integration/players/by-identity/checkout/override` (`POST`)
- `/api/v1/shops/:shopCode/integration/players/by-identity/device-actions` (`POST`)
- `/api/*` aliases rewrite to `/api/v1/*` and expose the unwrapped legacy
  success and string error shapes.

The production `createApp().routes` inventory is asserted in
`packages/server/test/shop-billing-routes.test.ts`. The true contract requires
behavioural assertions as well as registration: these paths must enforce
shop-scoped authentication and return the original response types.

## Live Activity delivery

Pre-refactor `packages/platform/src/live-activity-events.ts` drove
push-to-start, per-activity updates and end signals for player, staff and
integration session mutations. The equivalent shop mutation bridge is now
`packages/server/src/routes/shops/index.ts`, with event logic in
`live-activity-events.ts` and the original APNs push utilities under
`durable-objects/`. Cached idempotent responses must **not** trigger another
APNs notification. An APNs transport stub tests ActivityKit payload shape and
the database token lifecycle in `live-activity-push-flow.test.ts`.

Account start-token registration is different from activity-token registration:
`POST /api/v1/me/live-activity/start-token` registers a device's remote launch
token, whereas `POST /api/v1/shops/:shopCode/player/live-activity/register`
registers a particular running activity for update and end pushes.
Both are necessary.

## Transactional and safety boundaries

- Player entry requires a valid shop-scoped QR ticket, `consent:true`, and
  check-in location when configured. The tenant dependency's `startSession`
  already performs the leased, shop-priced entry operation.
- Session start, session stop, checkout, wallet, redeem and item purchases all
  take the one player billing lease (`PLAYER_BILLING_LOCK_SCOPE`, stored as
  `player.assets`), so a start can never interleave with a checkout. The lease
  is re-entrant within one call chain: a route already holding it (cashier
  entry, mahjong seating) may call a service that takes it again.
- Player checkout requires the checkout location outside the configured
  geofence; arbitrary player device commands are forbidden in favour of the
  QR-scoped machine-session actions.
- Financial player/staff operations use `runPlayerOperation` with a UUID
  `operationId`; repeated requests return the stored result rather than
  mutating the wallet again.
- Player list results keep `walletTotal` (displayed in yuan), session state,
  and both store identity and account-derived `web-account` bindings.

## CI

The Bun suite verifies historical route inventory, real production route
responses, QR rejection, wallet values and idempotent replays, activity-token
registration/retirement and APNs push fanout. The browser matrix runs Chromium
and WebKit at mobile and desktop widths for player balances and full role
navigation. WebKit is an approximation, not a substitute for real iPhone
ActivityKit/APNs testing.

## Staff identity and public DTO boundaries

`GET /api/v1/shops/:shopCode/staff/me` and its historical standalone alias
return exactly `{ staff: { id, displayName, role, canWrite } }` (inside the
canonical API's `data` envelope). The public `staff.role` is one of
`owner | manager | viewer` and never the internal authentication principal
discriminator `"staff"`. `canWrite` is false for viewers, true for owners
and managers. Display names come from the selected shop's staff record.

The interface `StaffMeView` is shared by the browser and server through
`@prism/core`. Never serialize a `StaffPrincipal` directly, and do not add
`staffRole` or `principalRole` to public responses as a workaround.

The `packages/server/test/shop-billing-routes.test.ts` production
`createApp()` suite checks **exact field equality** for owner, manager, and
viewer and verifies private password hashes/salts and API-token hashes are
absent from public staff-management endpoints. Browser tests check that the
owner settings tab exists, manager report quick archive works, and viewers
cannot use either action.

`node scripts/check-public-api-dtos.cjs` is a CI gate that scans the actual
TypeScript server sources and rejects direct JSON serialization of internal
auth principal objects or their `role` discriminator. It is intentionally a
static anti-leak guard, **not** a proof that all historic API DTOs match; each
consumer-specific contract must also have a runtime integration test.

## Historical API audit gates (full path inventory and response views)

Pre-consolidation commit `7fd7e7c` contains 150 explicitly declared
`/api/v1/*` method/path combinations across `server-hono/src/index.ts` and
`platform/src/index.ts`. The immutable
`packages/server/test/fixtures/pre-merge-api-routes.ts` captures them;
`pre-merge-api-routes.test.ts` asserts the **production**
`createApp().routes` still registers all 150. It also checks more than
100 historical tenant-scoped `player/staff/integration` endpoints and the
three wildcard-based ActivityKit endpoints, which the baseline static list
cannot detect by itself.

The original 31 public response serializer bodies in
`server-hono/src/views.ts` are frozen in
`packages/server/test/fixtures/pre-merge-views.ts.txt`.
`node scripts/check-api-view-compat.cjs` parses both original and current
TypeScript ASTs and rejects deletion or alteration of their function bodies.
In particular `toPlayerManagementView` must always output `createdAt`.

Intentional changes since the freeze, each additive and covered by
`packages/server/test/view-contracts.test.ts` (every earlier field still
present, only the listed additions):

- `toPricingConfigManagementView` adds `relations` (`{ requires, conflicts }`)
  for `time.priority` plans; other kinds are unchanged.
- `toPlayerCheckoutPreviewView` builds `timeline` through
  `previewBillTimeline()`, the one function every preview surface uses; same
  shape and content as before.
- `toPlayerCheckoutResultView` returns the timeline persisted with the
  checkout (what receipts read back later) instead of rebuilding it; same
  shape, plus `pricingReleaseIds`.

**Do not mistake these gates for a full semantic equivalence proof.**
Registration checks cannot detect returned 200s with wrong data. Serializer
checks cannot catch changed repository behavior, request validation, auth,
transaction side effects or controllers that bypass converters. Those require
the existing `createApp()` end-to-end tests and new per-route contract
fixtures for previously untested operations. CI should not be declared proof
of every API's complete historical compatibility until that coverage exists.
