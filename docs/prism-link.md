
## Billing timeline

Checkout previews and live merchant bills include a shared `timeline` document. Its events are grouped by actual engine timestamps and sorted newest first. Each session/config pair keeps its own colored rail across rule changes; non-overlapping pairs reuse lanes. Rule boundaries come from charge periods, never a fixed clock time. Continuous overnight rules do not add a midnight event. Display clocks use the pricing timezone without exposing its identifier in the UI.

The engine now retains plan names, unit rates/counts, periods and prior cap usage in pricing explanations. Stage amounts appear at their actual end/current time. Global cap adjustments remain independent entries, including negative amounts; timeline amounts and header breakdown reconcile to the checkout total. Rendering never recalculates prices. The total and timeline scroll together; the checkout action stays at the bottom. Legacy items without period metadata remain visible without fabricated timing details. The same Web component serves player bills, merchant live bills and merchant checkout dialogs; App Clip and Flutter consume the same payload.

Validation covers configurable shared boundaries (09:15), parallel signed charges, non-overlapping lane reuse, zero-charge sessions and overnight continuity. The existing MMW export was read locally for a cross-night comparison (89 total); no new D1 export was performed.
