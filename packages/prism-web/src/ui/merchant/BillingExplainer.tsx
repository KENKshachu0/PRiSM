import { CircleHelp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../../i18n";
import { Modal, buttonQuiet, useMerchant } from "./shared";

/**
 * The question-mark entry to the manual below. The rule editor opens it at the
 * field descriptions; the rule list opens it from the top.
 */
export function BillingManualButton({ section }: { section?: "fields" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`${buttonQuiet} size-9 shrink-0 justify-center`}
        aria-label={t("计费说明书")}
        title={t("计费说明书")}
        onClick={() => setOpen(true)}
      >
        <CircleHelp size={18} aria-hidden="true" />
      </button>
      {open && (
        <Modal title="计费说明书" close={() => setOpen(false)} xl>
          <BillingExplainer section={section} />
        </Modal>
      )}
    </>
  );
}

/**
 * How a bill is built, drawn with one worked example. The figures follow the
 * engine (docs/billing-flow.md): units round up only past the grace minutes,
 * each rule segment counts its own units, a rule cap stops that segment's
 * growth, a spending cap merges plans, and checkout spends bonus balance
 * before paid balance.
 */
export function BillingExplainer({ section }: { section?: "fields" } = {}) {
  const { t } = useI18n();
  const { shopCode } = useMerchant();
  const fields = useRef<HTMLElement>(null);
  useEffect(() => {
    if (section === "fields") fields.current?.scrollIntoView({ block: "start" });
  }, [section]);
  const kinds: [string, string][] = [
    [t("按时计费"), t("按时长收费。可以分成多个时段，每个时段有自己的单价、宽限和封顶。入场计费通常用这一种。")],
    [t("固定收费"), t("每次入场收取一笔固定金额，不看时长。")],
    [t("消费封顶"), t("把所有按时计费的规则合起来封顶，到顶后不再收费。它自己不产生费用。")],
  ];
  const basics: [string, string][] = [
    [t("名称"), t("规则在列表和账单里显示的名字，最多 80 个字。")],
    [t("计费方式"), t("创建后不能更改。")],
    [t("启用规则"), t("停用后不再参与计费。已经在店的玩家仍按入场时的规则计费。")],
  ];
  const periods: [string, string][] = [
    [t("名称"), t("显示在账单时间轴上的时段名称，例如日场、夜场。")],
    [t("开始"), t("时段每天的开始时间，按店铺时区。开始与结束相同表示全天。")],
    [t("结束"), t("时段每天的结束时间。早于开始时间表示跨过午夜。")],
    [t("计费间隔"), t("一个计费单位的时长，单位分钟，需要大于 0。")],
    [t("收费金额"), t("每个计费单位的价格，单位元。")],
    [t("宽限时长"), t("不足一个单位的余数不超过宽限时不多收；超过宽限才多收一个单位。单位分钟。")],
    [t("时段封顶"), t("这个时段内累计费用的上限，单位元。填 0 表示不限。")],
    [t("优先级"), t("同一条规则内，同一时刻有多个时段命中时，只采用数字最大的那个。")],
    [t("适用星期"), t("只在勾选的星期生效。")],
    [t("指定日期"), t("只在这些日期生效，格式如 2026-10-01，多个日期用逗号分隔。")],
    [t("启用时段"), t("取消勾选后，这个时段不参与计费。")],
  ];
  const fixed: [string, string][] = [
    [t("账单名称"), t("显示在玩家账单上的名称。")],
    [t("金额"), t("每次入场收取一次，单位元。")],
  ];
  const cap: [string, string][] = [
    [t("适用规则"), t("店里所有按时计费的规则。固定收费不计入封顶。")],
    [t("封顶金额"), t("所有按时计费的规则在一个时段内的合计上限，单位元，需要大于 0。")],
    [t("时段"), t("名称、开始、结束、优先级、适用星期、指定日期的含义与按时计费相同。")],
  ];
  const notes = [
    t("新建的规则不会自动计费。它要成为资源组的计费方案、某个资源自己的计费方案，或被其他规则「依赖」，玩家扫到对应资源时才会开始计费。"),
    t("修改、停用、归档规则只影响之后入场的玩家。已经在店的玩家按入场时的版本计费，结账后重新入场才使用最新版。"),
    t("没有命中任何时段的时间不产生费用。资源组的方案需要覆盖全部营业时间，要全天生效时让开始与结束相同。"),
    t("同一条规则内重叠的时段按优先级选一个；不同规则的费用相加，不会自动选最便宜的。不要用优先级相同的重叠时段表达规则。"),
    t("跨过午夜的时段整体归属开始的那一天：星期和指定日期按开始日匹配，封顶额度也只算一份。"),
    t("封顶按玩家累计，已结算的历史会计入，同一玩家重新扫码不会重置额度。"),
    t("时段封顶只限制这一个时段，填 0 表示不封顶。要把同时进行的几条计费（例如入场加麻将）合计封顶，使用消费封顶；两种封顶同时生效时，按实际收取的金额一起计算，每个单位只少收一次。"),
    t("计费单位在每个时段内单独计算，跨时段边界的费用不一定等于把总时长一次算完。"),
    t("刚入场且没有操作过设备时，宽限内不收费；操作过设备后，第一个单位照收。开门和空调操作不算设备操作。"),
    t("金额单位是元，最多两位小数。"),
    t("保存后用「计费模拟器」按真实时间验证一遍。"),
  ];

  return (
    <div className="grid gap-8">
      <Figure
        title="1. 按单位计费，宽限内不进位"
        caption="例：每 30 分钟 10 元，宽限 5 分钟。时长超过整单位但不超过宽限，不多收；超过宽限才多收一个单位。刚入场 5 分钟内没操作设备就离开，不收费；操作过设备后，第一个单位照收。"
      >
        <UnitChart />
      </Figure>
      <Figure
        title="2. 跨时段分别计算，时段封顶只管本时段"
        caption="例：日场 12 元/小时、本时段封顶 40 元；夜场 8 元/小时。14:00 入场、20:30 离店：日场 4 小时本应 48 元，封顶后 40 元；夜场 2 小时 30 分超过宽限，算 3 个单位 24 元，合计 64 元。玩家入场时锁定当时的规则版本，之后改规则不影响已经在店的玩家。"
      >
        <TimelineChart />
      </Figure>
      <Figure
        title="3. 多条计费同时进行，消费封顶合并计算"
        caption="一位玩家可以同时有几条计费：入场一条，上麻将桌再开一条，各按自己的规则算。「消费封顶」把所有按时计费的规则合起来封顶，例如全天合计最多 80 元。停止某条计费只是停表，不扣钱；结账时一次结清全部。"
      >
        <SessionsChart />
      </Figure>
      <Figure
        title="4. 结账：先算优惠，再扣余额"
        caption="封顶之后再用优惠券等整单优惠，得到应付金额。扣款先用赠送余额，再用充值余额。余额不够时结不了账，计时继续，店员可以用「充值结账」现场补款；前台收银的玩家则在前台付款，不经过余额。"
      >
        <CheckoutChart />
      </Figure>
      <section ref={fields} className="grid scroll-mt-20 gap-6">
        <h3 className="text-base font-semibold">{t("字段说明")}</h3>
        <ManualRows title={t("计费方式")} rows={kinds} />
        <ManualRows title={t("基本信息")} rows={basics} />
        <ManualRows title={t("按时计费的时段")} rows={periods} />
        <ManualRows title={t("固定收费")} rows={fixed} />
        <ManualRows title={t("消费封顶")} rows={cap} />
      </section>
      <section className="grid gap-3">
        <h3 className="text-base font-semibold">{t("配置注意事项")}</h3>
        <ol className="grid list-decimal gap-2 pl-5 text-sm leading-relaxed text-ink/75">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ol>
      </section>
      <p className="text-sm text-ink/60">
        {t("想用本店的规则算一笔？")}{" "}
        <Link className="underline" to={`/merchant/${encodeURIComponent(shopCode)}/pricing?simulate=1`}>
          {t("打开计费模拟器")}
        </Link>
      </p>
    </div>
  );
}

function ManualRows({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="grid gap-3">
      <h4 className="text-sm font-semibold">{title}</h4>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
        {rows.map(([name, text]) => (
          <div key={name} className="contents">
            <dt className="font-medium">{name}</dt>
            <dd className="text-ink/70 max-sm:mb-2">{text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Figure({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <figure className="grid gap-3">
      <h4 className="font-semibold">{t(title)}</h4>
      <div className="overflow-x-auto rounded-lg border border-ink/10 bg-ink/[0.02] p-3">
        {children}
      </div>
      <figcaption className="text-sm leading-relaxed text-ink/65">
        {t(caption)}
      </figcaption>
    </figure>
  );
}

const label = "fill-current text-[11px] text-ink/60";
const strong = "fill-current text-[12px] font-semibold text-ink";

function UnitChart() {
  const { t } = useI18n();
  const x = (minutes: number) => 44 + minutes * 5;
  const y = (yuan: number) => 200 - yuan * 3.6;
  const steps: [number, number, number][] = [
    [0, 5, 0],
    [5, 35, 10],
    [35, 65, 20],
    [65, 95, 30],
    [95, 100, 40],
  ];
  return (
    <svg viewBox="0 0 560 236" className="min-w-[30rem]" role="img" aria-label={t("按单位计费的阶梯图")}>
      <text x={x(0) - 8} y={22} textAnchor="end" className={label}>{t("元")}</text>
      {[10, 20, 30, 40].map((v) => (
        <g key={v}>
          <line x1={x(0)} x2={x(100)} y1={y(v)} y2={y(v)} className="stroke-current text-ink/10" />
          <text x={x(0) - 8} y={y(v) + 4} textAnchor="end" className={label}>{v}</text>
        </g>
      ))}
      <text x={x(0) - 8} y={y(0) + 4} textAnchor="end" className={label}>0</text>
      {[0, 30, 60, 90].map((m) => (
        <text key={m} x={x(m)} y={220} textAnchor="middle" className={label}>{t("{count} 分", { count: m })}</text>
      ))}
      <rect x={x(0)} y={30} width={x(5) - x(0)} height={y(0) - 30} className="fill-current text-mint/10" />
      {[30, 60, 90].map((m) => (
        <rect key={m} x={x(m)} y={30} width={x(m + 5) - x(m)} height={y(0) - 30} className="fill-current text-coral/10" />
      ))}
      <line x1={x(0)} x2={x(100)} y1={y(0)} y2={y(0)} className="stroke-current text-ink/30" />
      {steps.map(([from, to, v], index) => (
        <g key={from}>
          <line x1={x(from)} x2={x(to)} y1={y(v)} y2={y(v)} strokeWidth={3} className="stroke-current text-mint" />
          {index > 0 && (
            <line x1={x(from)} x2={x(from)} y1={y(steps[index - 1]![2])} y2={y(v)} strokeDasharray="3 3" className="stroke-current text-mint/60" />
          )}
        </g>
      ))}
      <circle cx={x(35)} cy={y(10)} r={4} className="fill-current text-mint" />
      <text x={x(35) - 6} y={y(10) - 10} textAnchor="end" className={strong}>{t("35 分钟 10 元")}</text>
      <circle cx={x(36)} cy={y(20)} r={4} className="fill-current text-coral" />
      <text x={x(36) + 6} y={y(20) - 10} className={strong}>{t("36 分钟 20 元")}</text>
      <text x={x(0)} y={22} className={label}>{t("开场宽限")}</text>
      {[30, 60, 90].map((m) => (
        <text key={m} x={x(m + 2.5)} y={22} textAnchor="middle" className={label}>{t("宽限 5 分钟")}</text>
      ))}
    </svg>
  );
}

function TimelineChart() {
  const { t } = useI18n();
  // 12:00 → 22:00
  const x = (hour: number) => 44 + (hour - 12) * 50;
  const y = (yuan: number) => 222 - yuan * 1.9;
  // Cumulative cost: one unit is charged once the visit passes the grace into it.
  const points: [number, number][] = [
    [14, 0], [14 + 5 / 60, 0], [14 + 5 / 60, 12], [15 + 5 / 60, 12], [15 + 5 / 60, 24],
    [16 + 5 / 60, 24], [16 + 5 / 60, 36], [17 + 5 / 60, 36], [17 + 5 / 60, 40],
    [18 + 5 / 60, 40], [18 + 5 / 60, 48], [19 + 5 / 60, 48], [19 + 5 / 60, 56],
    [20 + 5 / 60, 56], [20 + 5 / 60, 64], [20.5, 64],
  ];
  return (
    <svg viewBox="0 0 560 256" className="min-w-[30rem]" role="img" aria-label={t("跨时段计费的时间轴")}>
      <rect x={x(12)} y={16} width={x(18) - x(12)} height={26} rx={6} className="fill-current text-mint/15" />
      <rect x={x(18)} y={16} width={x(22) - x(18)} height={26} rx={6} className="fill-current text-ink/10" />
      <text x={x(15)} y={33} textAnchor="middle" className={strong}>{t("日场 12 元/小时 · 封顶 40")}</text>
      <text x={x(20)} y={33} textAnchor="middle" className={strong}>{t("夜场 8 元/小时")}</text>
      <rect x={x(14)} y={52} width={x(20.5) - x(14)} height={8} rx={4} className="fill-current text-ink/50" />
      <text x={x(14)} y={76} className={label}>{t("14:00 入场")}</text>
      <text x={x(20.5)} y={76} textAnchor="end" className={label}>{t("20:30 离店")}</text>
      {[0, 20, 40, 60].map((v) => (
        <g key={v}>
          <line x1={x(12)} x2={x(22)} y1={y(v)} y2={y(v)} className="stroke-current text-ink/10" />
          <text x={x(12) - 8} y={y(v) + 4} textAnchor="end" className={label}>{v}</text>
        </g>
      ))}
      <line x1={x(12)} x2={x(18)} y1={y(40)} y2={y(40)} strokeDasharray="5 4" className="stroke-current text-coral" />
      <text x={x(12) + 4} y={y(40) - 6} className={label}>{t("日场封顶 40 元")}</text>
      <polyline
        points={points.map(([h, v]) => `${x(h)},${y(v)}`).join(" ")}
        fill="none"
        strokeWidth={3}
        className="stroke-current text-mint"
      />
      <line x1={x(18)} x2={x(18)} y1={16} y2={y(0)} strokeDasharray="2 4" className="stroke-current text-ink/30" />
      <circle cx={x(20.5)} cy={y(64)} r={4} className="fill-current text-mint" />
      <text x={x(20.5) + 8} y={y(64) + 14} className={strong}>{t("64 元")}</text>
      {[12, 14, 16, 18, 20, 22].map((h) => (
        <text key={h} x={x(h)} y={y(0) + 18} textAnchor="middle" className={label}>{`${h}:00`}</text>
      ))}
    </svg>
  );
}

function SessionsChart() {
  const { t } = useI18n();
  const x = (hour: number) => 96 + (hour - 12) * 30;
  const money = (yuan: number) => 96 + yuan * 3;
  return (
    <svg viewBox="0 0 560 196" className="min-w-[30rem]" role="img" aria-label={t("多条计费与消费封顶")}>
      <text x={8} y={36} className={strong}>{t("入场")}</text>
      <rect x={x(14)} y={24} width={x(20.5) - x(14)} height={18} rx={5} className="fill-current text-mint/70" />
      <text x={x(20.5) + 6} y={37} className={label}>{t("64 元")}</text>
      <text x={8} y={72} className={strong}>{t("麻将桌")}</text>
      <rect x={x(16)} y={60} width={x(18) - x(16)} height={18} rx={5} className="fill-current text-ink/40" />
      <text x={x(18) + 6} y={73} className={label}>{t("15 元/小时 · 30 元")}</text>
      {[12, 14, 16, 18, 20, 22].map((h) => (
        <text key={h} x={x(h)} y={100} textAnchor="middle" className={label}>{`${h}:00`}</text>
      ))}
      <line x1={8} x2={552} y1={116} y2={116} className="stroke-current text-ink/10" />
      <text x={8} y={160} className={strong}>{t("合计")}</text>
      <rect x={money(0)} y={148} width={money(64) - money(0)} height={18} className="fill-current text-mint/70" />
      <rect x={money(64)} y={148} width={money(94) - money(64)} height={18} className="fill-current text-ink/40" />
      <rect x={money(80)} y={148} width={money(94) - money(80)} height={18} className="fill-current text-coral/40" />
      <line x1={money(80)} x2={money(80)} y1={134} y2={176} strokeDasharray="4 3" className="stroke-current text-coral" />
      <text x={money(80)} y={130} textAnchor="middle" className={label}>{t("消费封顶 80")}</text>
      <text x={money(94) + 8} y={161} className={strong}>{t("94 → 80 元")}</text>
    </svg>
  );
}

function CheckoutChart() {
  const { t } = useI18n();
  const scale = (yuan: number) => yuan * 3.6;
  const left = 150;
  const rows: { name: string; from: number; to: number; tone: string; note: string }[] = [
    { name: "计费合计", from: 0, to: 94, tone: "text-ink/40", note: "94" },
    { name: "消费封顶", from: 80, to: 94, tone: "text-coral/60", note: "−14" },
    { name: "优惠券", from: 74, to: 80, tone: "text-coral/60", note: "−6" },
    { name: "应付", from: 0, to: 74, tone: "text-mint/70", note: "74" },
    { name: "扣赠送余额", from: 0, to: 20, tone: "text-mint/40", note: "20" },
    { name: "扣充值余额", from: 20, to: 74, tone: "text-mint/70", note: "54" },
  ];
  return (
    <svg viewBox="0 0 560 196" className="min-w-[30rem]" role="img" aria-label={t("结账扣款顺序")}>
      {rows.map((row, index) => (
        <g key={row.name} transform={`translate(0 ${12 + index * 30})`}>
          <text x={left - 10} y={15} textAnchor="end" className={index === 3 ? strong : label}>{t(row.name)}</text>
          <rect x={left + scale(row.from)} y={2} width={scale(row.to - row.from)} height={18} rx={4} className={`fill-current ${row.tone}`} />
          <text x={left + scale(row.to) + 6} y={15} className={label}>{row.note}</text>
        </g>
      ))}
      <line x1={left} x2={left + scale(94)} y1={12 + 3 * 30 - 5} y2={12 + 3 * 30 - 5} className="stroke-current text-ink/15" />
    </svg>
  );
}
