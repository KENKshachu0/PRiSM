import { useMemo } from "react";
import { useI18n } from "../../i18n";
import type { ResourceGroup } from "../../api";
import type { Pricing } from "./Pricing";

const NODE_W = 150;
const NODE_H = 52;
const GAP_X = 36;
const GAP_Y = 64;
const PAD = 16;

/**
 * The shop's time plans and how they run together. A plan sits one row below
 * the deepest plan it requires, so the base plans are on top; a solid arrow
 * points at a plan that must bill too, a dashed red line joins two plans that
 * never bill together. Under each plan: the resource groups that start it.
 */
export function PlanRelationGraph({
  plans,
  groups,
  onSelect,
}: {
  plans: Pricing[];
  groups: ResourceGroup[];
  onSelect?: (plan: Pricing) => void;
}) {
  const { t } = useI18n();
  const layout = useMemo(() => {
    const live = plans.filter((plan) => plan.kind === "time.priority" && plan.status !== "archived");
    const byId = new Map(live.map((plan) => [plan.id, plan]));
    const requires = (plan: Pricing) => (plan.relations?.requires ?? []).filter((id) => byId.has(id));
    const depth = new Map<string, number>();
    const depthOf = (plan: Pricing, seen: Set<string> = new Set()): number => {
      if (depth.has(plan.id)) return depth.get(plan.id)!;
      if (seen.has(plan.id)) return 0;
      seen.add(plan.id);
      const value = Math.max(-1, ...requires(plan).map((id) => depthOf(byId.get(id)!, seen))) + 1;
      depth.set(plan.id, value);
      return value;
    };
    live.forEach((plan) => depthOf(plan));
    const conflictsOf = (plan: Pricing) =>
      live.filter((other) => (plan.relations?.conflicts ?? []).includes(other.id) || (other.relations?.conflicts ?? []).includes(plan.id));
    const sortedRows: Pricing[][] = [];
    for (const plan of [...live].sort((a, b) => a.name.localeCompare(b.name))) {
      (sortedRows[depth.get(plan.id)!] ??= []).push(plan);
    }
    // Plans that exclude each other sit side by side, so a short line joins them.
    const rows = sortedRows.map((row) => {
      const placed: Pricing[] = [];
      const visit = (plan: Pricing) => {
        if (placed.includes(plan)) return;
        placed.push(plan);
        for (const other of conflictsOf(plan)) if (row.includes(other)) visit(other);
      };
      row.forEach(visit);
      return placed;
    });
    const width = Math.max(1, ...rows.map((row) => row.length)) * (NODE_W + GAP_X) - GAP_X + PAD * 2;
    const position = new Map<string, { x: number; y: number }>();
    rows.forEach((row, r) => {
      const rowWidth = row.length * (NODE_W + GAP_X) - GAP_X;
      row.forEach((plan, i) =>
        position.set(plan.id, { x: (width - rowWidth) / 2 + i * (NODE_W + GAP_X), y: PAD + r * (NODE_H + GAP_Y) }),
      );
    });
    const height = PAD * 2 + rows.length * (NODE_H + GAP_Y) - GAP_Y;
    const requireEdges = live.flatMap((plan) => requires(plan).map((target) => ({ from: plan.id, to: target })));
    const conflictEdges: { a: string; b: string }[] = [];
    for (const plan of live)
      for (const other of plan.relations?.conflicts ?? [])
        if (byId.has(other) && !conflictEdges.some((edge) => (edge.a === other && edge.b === plan.id) || (edge.a === plan.id && edge.b === other)))
          conflictEdges.push({ a: plan.id, b: other });
    return { live, position, width, height, requireEdges, conflictEdges };
  }, [plans]);

  if (layout.live.length < 2) return null;
  const startedBy = (planId: string) =>
    groups.filter((group) => group.defaultPricingConfigId === planId).map((group) => t(group.name));
  const center = (id: string) => {
    const p = layout.position.get(id)!;
    return { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 };
  };

  return (
    <figure className="grid gap-2">
      <div className="overflow-x-auto rounded-xl border border-ink/10 bg-ink/[.02]">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          className="mx-auto block max-w-none"
          role="img"
          aria-label={t("计费规则关系图")}
        >
          <defs>
            <marker id="requires-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#5982cc" />
            </marker>
          </defs>
          {layout.requireEdges.map(({ from, to }) => {
            const a = layout.position.get(from)!;
            const b = layout.position.get(to)!;
            const x1 = a.x + NODE_W / 2, y1 = a.y;
            const x2 = b.x + NODE_W / 2, y2 = b.y + NODE_H;
            return (
              <path
                key={`r:${from}:${to}`}
                d={`M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`}
                fill="none"
                stroke="#5982cc"
                strokeWidth="2"
                markerEnd="url(#requires-arrow)"
              />
            );
          })}
          {layout.conflictEdges.map(({ a, b }) => {
            const [p, q] = [center(a), center(b)].sort((m, n) => m.x - n.x) as [{ x: number; y: number }, { x: number; y: number }];
            const sameRow = Math.abs(p.y - q.y) < 1;
            const adjacent = sameRow && q.x - p.x <= NODE_W + GAP_X + 1;
            // Side by side: a short line between the boxes. Further apart on a
            // row: an arc under the row. Across rows: a straight line.
            const d = adjacent
              ? `M ${p.x + NODE_W / 2} ${p.y} L ${q.x - NODE_W / 2} ${q.y}`
              : sameRow
                ? `M ${p.x} ${p.y + NODE_H / 2} Q ${(p.x + q.x) / 2} ${p.y + NODE_H / 2 + 36} ${q.x} ${q.y + NODE_H / 2}`
                : `M ${p.x} ${p.y} L ${q.x} ${q.y}`;
            return <path key={`c:${a}:${b}`} d={d} fill="none" stroke="#cf7262" strokeWidth="2" strokeDasharray="6 5" />;
          })}
          {layout.live.map((plan) => {
            const p = layout.position.get(plan.id)!;
            const users = startedBy(plan.id);
            return (
              <g
                key={plan.id}
                transform={`translate(${p.x} ${p.y})`}
                className={onSelect ? "cursor-pointer" : undefined}
                role={onSelect ? "button" : undefined}
                tabIndex={onSelect ? 0 : undefined}
                aria-label={plan.name}
                onClick={() => onSelect?.(plan)}
                onKeyDown={(e) => {
                  if (onSelect && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onSelect(plan);
                  }
                }}
              >
                <rect width={NODE_W} height={NODE_H} rx="10" fill="var(--color-panel, #fff)" stroke={plan.enabled ? "#209b87" : "#9aa29e"} strokeWidth="1.5" strokeDasharray={plan.enabled ? undefined : "4 3"} />
                <text x={NODE_W / 2} y={users.length ? 21 : NODE_H / 2} textAnchor="middle" dominantBaseline="middle" fontSize="13" fontWeight="600" fill="currentColor">
                  {plan.name.length > 11 ? `${plan.name.slice(0, 10)}…` : plan.name}
                </text>
                {users.length > 0 && (
                  <text x={NODE_W / 2} y="38" textAnchor="middle" dominantBaseline="middle" fontSize="10" fill="#7a827e">
                    {(() => { const text = users.join("、"); return text.length > 14 ? `${text.slice(0, 13)}…` : text; })()}
                  </text>
                )}
                <title>{[plan.name, users.length ? `${t("资源组")}：${users.join("、")}` : ""].filter(Boolean).join("\n")}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink/60">
        <span><span className="mr-1 inline-block w-5 border-t-2 border-[#5982cc] align-middle" />{t("依赖")}</span>
        <span><span className="mr-1 inline-block w-5 border-t-2 border-dashed border-[#cf7262] align-middle" />{t("冲突")}</span>
        <span><span className="mr-1 align-middle text-[10px] text-ink/50">{t("名称")}</span>{t("资源组")}</span>
        <span><span className="mr-1 inline-block h-3 w-5 rounded border border-dashed border-ink/40 align-middle" />{t("已停用")}</span>
      </figcaption>
    </figure>
  );
}
