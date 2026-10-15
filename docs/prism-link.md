
## Billing timeline

Checkout previews and live merchant bills include a shared `timeline` document. Its events are grouped by actual engine timestamps and sorted newest first. Each session/config pair keeps its own colored rail across rule changes; non-overlapping pairs reuse lanes. Rule boundaries come from charge periods, never a fixed clock time. An active quote tail rounded before the preview clock is rendered at the current preview time instead of being marked as a rule switch. Continuous overnight rules do not add a midnight event. Display clocks use the pricing timezone without exposing its identifier in the UI.

The engine now retains plan names, unit rates/counts, periods and prior cap usage in pricing explanations. Stage amounts appear at their actual end/current time. Global cap adjustments remain independent entries, including negative amounts; timeline amounts and header breakdown reconcile to the checkout total. Rendering never recalculates prices. The total and timeline scroll together; the checkout action stays at the bottom. Legacy items without period metadata remain visible without fabricated timing details. The same Web component serves player bills, merchant live bills and merchant checkout dialogs; App Clip and Flutter consume the same payload. The shared pieces live in `packages/prism-web/src/ui/PlayerAccount.tsx`, so the header account menu and the standalone `/t/:shopCode` shop page render one implementation of the bill, redeem, history and wallet sections.

## Shop-only page and deep links

`/t/:shopCode` is the ticket-free shop surface described in `platform-merge.md`. It exists because the Live Activity on the lock screen and in the Dynamic Island needs somewhere to send a tap that does not imply a machine, and because the Bot's 到店校验 link previously landed on `/m/expired`. The Apple association file claims `/t/*` for the app while `/t/*/*` still mints a machine ticket, and `run_worker_first` deliberately lists only the two-segment form so the shop page is served by the SPA fallback.

Validation covers configurable shared boundaries (09:15), parallel signed charges, non-overlapping lane reuse, zero-charge sessions and overnight continuity. The existing MMW export was read locally for a cross-night comparison (89 total); no new D1 export was performed.

## Remote Live Activities

A store visit Live Activity is created on the phone with `pushType: .token`, and the app reports that per-activity APNs token to `POST /api/v1/shops/:shopCode/player/live-activity/register`. From then on a session started or settled on **any** channel updates that phone's Dynamic Island, including while the app is suspended or killed. The player, staff, integration and cashier write channels pass through the tenant middleware in `packages/server/src/routes/shops/index.ts`, so the notification hook lives there and the core billing domain stays unaware that Live Activities exist. Registration and retirement are handled directly in the server routes, because an APNs token is a transport concern, not a billing one. Full design, payload contract and failure handling: `live-activity-push.md`.
