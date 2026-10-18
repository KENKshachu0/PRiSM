import { parseLocalDateTime } from "@prism/core";
import { useState } from "react";
import { Plus } from "lucide-react";
import { useI18n } from "../../i18n";
import { displayDateTime } from "../bill-time";
import { useScrollFade } from "../use-scroll-fade";
import {
  AssetDetails,
  EffectDetails,
  PresentDetails,
  RedeemCodeDetails,
  assetTypeName,
  availabilityLabel,
  effectSummary,
} from "./AssetDetails";
import type { Effect, Grant, Present, RedeemCode } from "./asset-types";
import {
  ActionForm,
  Field,
  Modal,
  State,
  Table,
  button,
  cell,
  input,
  primary,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
  type Asset,
} from "./shared";

export function AssetsPage() {
  const { t } = useI18n();
  const { canWrite, timeZone } = useMerchant();
  const request = useStaffApi();
  const assets = useResource<{ assetDefinitions: Asset[] }>(
    "asset-definitions",
  );
  const effects = useResource<{ pricingEffects: Effect[] }>("pricing-effects");
  const presents = useResource<{ presents: Present[] }>("presents");
  const codes = useResource<{ redeemCodes: RedeemCode[] }>("redeem-codes");
  const [tab, setTab] = useState("assets");
  const tabRef = useScrollFade<HTMLElement>();
  const [creatingAsset, setCreatingAsset] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [effect, setEffect] = useState<Effect | null>(null);
  const [gift, setGift] = useState(false);
  const [code, setCode] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [detail, setDetail] = useState<
    | { kind: "asset"; item: Asset }
    | { kind: "effect"; item: Effect }
    | { kind: "present"; item: Present }
    | { kind: "code"; item: RedeemCode }
    | null
  >(null);
  const date = (value: string | null | undefined) =>
    value ? displayDateTime(value, timeZone) : "—";
  const [confirmation, setConfirmation] = useState<{
    name: string;
    path: string;
  } | null>(null);
  const reload = () => {
    assets.reload();
    effects.reload();
    presents.reload();
    codes.reload();
  };
  const visibleAssets =
    assets.data?.assetDefinitions.filter(
      (a) => showArchived || a.status !== "archived",
    ) ?? [];
  const visibleEffects =
    effects.data?.pricingEffects.filter(
      (e) => showArchived || e.status !== "archived",
    ) ?? [];
  const visiblePresents =
    presents.data?.presents.filter(
      (p) => showArchived || p.status !== "archived",
    ) ?? [];
  const visibleCodes = codes.data?.redeemCodes ?? [];
  const createLabel =
    tab === "assets"
      ? "新建资产"
      : tab === "effects"
        ? "新建优惠"
        : tab === "gifts"
          ? "新建礼物"
          : "生成兑换码";
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("资产与兑换")}</h2>
        {canWrite && (
          <button
            className={primary}
            onClick={() => {
              if (tab === "assets") {
                setCreatingAsset(true);
                setEditing({
                  type: "coupon",
                  code: crypto.randomUUID(),
                  name: "",
                  stackable: true,
                  pricingEffectId: null,
                  status: "active",
                  metadata: null,
                });
              } else if (tab === "effects")
                setEffect({
                  id: "",
                  name: "",
                  type: "discount",
                  scope: "unified",
                  value: 1,
                  consumable: true,
                  limitPerDay: null,
                  status: "active",
                  config: null,
                });
              else if (tab === "gifts") setGift(true);
              else setCode(true);
            }}
          >
            <Plus size={16} />
            {t(createLabel)}
          </button>
        )}
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="scroll-fade min-w-0 flex-1">
          <nav
            ref={tabRef}
            className="flex gap-1 overflow-x-auto border-b border-ink/10"
            aria-label={t("资产分类")}
          >
            {[
              ["assets", "资产"],
              ["effects", "优惠"],
              ["gifts", "礼物"],
              ["codes", "兑换码"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={`focus-ring whitespace-nowrap border-b-2 px-4 py-3 text-sm ${tab === key ? "border-mint font-semibold text-ink" : "border-transparent text-ink/55 hover:text-ink"}`}
                onClick={() => setTab(key!)}
                aria-current={tab === key ? "page" : undefined}
              >
                {t(label!)}
              </button>
            ))}
          </nav>
        </div>
        {tab !== "codes" && (
          <label className="flex shrink-0 items-center gap-2 pb-1 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            {t("显示已归档")}
          </label>
        )}
      </div>
      {tab === "assets" &&
        (!assets.data ? (
          <State error={assets.error} />
        ) : !visibleAssets.length ? (
          <Empty title="还没有资产" />
        ) : (
          <Table
            headers={["名称", "类型", "关联优惠", "有效期", "状态", "操作"]}
          >
            {visibleAssets.map((a) => (
                <tr key={`${a.type}:${a.code}`}>
                  <td className={cell}>
                    <p className="font-medium">{a.name}</p>
                    <p className="mt-1 text-xs text-ink/60">
                      {t(a.stackable ? "数量可叠加" : "数量不可叠加")}
                    </p>
                    {a.metadata?.hiddenFromPlayer === true && (
                      <p className="mt-1 text-xs text-ink/60">
                        {t("对玩家隐藏")}
                      </p>
                    )}
                  </td>
                  <td className={cell}>{assetTypeName(a.type, t)}</td>
                  <td className={cell}>
                    {effects.data?.pricingEffects.find(
                      (e) => e.id === a.pricingEffectId,
                    )?.name ??
                      a.pricingEffect?.name ??
                      a.pricingEffectId ??
                      t("无")}
                  </td>
                  <td className={`${cell} whitespace-nowrap`}>
                    <p>{a.activeAt ? date(a.activeAt) : t("立即生效")}</p>
                    <p className="mt-1 text-xs text-ink/60">
                      {a.expiresAt ? date(a.expiresAt) : t("永久有效")}
                    </p>
                  </td>
                  <td className={cell}>{availabilityLabel(a, t)}</td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={button}
                        onClick={() => setDetail({ kind: "asset", item: a })}
                      >
                        {t("详情")}
                      </button>
                      {canWrite && (
                        <>
                          {a.status !== "archived" && (
                            <button
                              className={button}
                              onClick={() => {
                                setCreatingAsset(false);
                                setEditing(a);
                              }}
                            >
                              {t("编辑")}
                            </button>
                          )}
                          <button
                            className={button}
                            onClick={() =>
                              setConfirmation({
                                name: a.name,
                                path: `asset-definitions/${segment(a.type)}/${segment(a.code)}/${a.status === "archived" ? "restore" : "archive"}`,
                              })
                            }
                          >
                            {t(a.status === "archived" ? "恢复" : "归档")}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </Table>
        ))}
      {tab === "effects" &&
        (!effects.data ? (
          <State error={effects.error} />
        ) : !visibleEffects.length ? (
          <Empty title="还没有优惠" />
        ) : (
          <Table headers={["名称", "优惠方式", "使用限制", "状态", "操作"]}>
            {visibleEffects.map((e) => (
                <tr key={e.id}>
                  <td className={`${cell} font-medium`}>{e.name}</td>
                  <td className={cell}>
                    <p>{effectSummary(e, t)}</p>
                    <p className="mt-1 text-xs text-ink/60">
                      {t(e.scope === "session" ? "单项消费" : "整笔账单")}
                    </p>
                  </td>
                  <td className={cell}>
                    <p>{t(e.consumable ? "使用后扣除" : "使用后保留")}</p>
                    <p className="mt-1 text-xs text-ink/60">
                      {e.limitPerDay == null
                        ? t("每日不限次数")
                        : t("每日最多 {count} 次", { count: e.limitPerDay })}
                    </p>
                  </td>
                  <td className={cell}>{availabilityLabel(e, t)}</td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={button}
                        onClick={() => setDetail({ kind: "effect", item: e })}
                      >
                        {t("详情")}
                      </button>
                      {canWrite && (
                        <>
                          {e.status !== "archived" && (
                            <button
                              className={button}
                              onClick={() => setEffect(e)}
                            >
                              {t("编辑")}
                            </button>
                          )}
                          <button
                            className={button}
                            onClick={() =>
                              setConfirmation({
                                name: e.name,
                                path: `pricing-effects/${segment(e.id)}/${e.status === "archived" ? "restore" : "archive"}`,
                              })
                            }
                          >
                            {t(e.status === "archived" ? "恢复" : "归档")}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </Table>
        ))}
      {tab === "gifts" &&
        (!presents.data ? (
          <State error={presents.error} />
        ) : !visiblePresents.length ? (
          <Empty title="还没有礼物" />
        ) : (
          <Table headers={["礼物", "内容", "领取限制", "状态", "操作"]}>
            {visiblePresents.map((p) => (
                <tr key={p.id}>
                  <td className={`${cell} font-medium`}>{p.name}</td>
                  <td className={cell}>
                    {p.grants.map((g, i) => (
                      <p key={i}>
                        {assets.data?.assetDefinitions.find(
                          (a) =>
                            a.type === g.assetType && a.code === g.assetCode,
                        )?.name ?? g.assetCode}{" "}
                        × {g.amount}
                      </p>
                    ))}
                  </td>
                  <td className={cell}>
                    {t(p.oncePerPlayer ? "每位玩家仅限一次" : "可重复领取")}
                  </td>
                  <td className={cell}>{availabilityLabel(p, t)}</td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={button}
                        onClick={() => setDetail({ kind: "present", item: p })}
                      >
                        {t("详情")}
                      </button>
                      {canWrite && (
                        <button
                          className={button}
                          onClick={() =>
                            setConfirmation({
                              name: p.name,
                              path: `presents/${segment(p.id)}/${p.status === "archived" ? "restore" : "archive"}`,
                            })
                          }
                        >
                          {t(p.status === "archived" ? "恢复" : "归档")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </Table>
        ))}
      {tab === "codes" &&
        (!codes.data ? (
          <State error={codes.error} />
        ) : !visibleCodes.length ? (
          <Empty title="还没有兑换码" />
        ) : (
          <Table headers={["兑换码", "礼物", "使用次数", "到期", "操作"]}>
            {visibleCodes.map((c) => (
              <tr key={c.id}>
                <td className={cell}>
                  <code className="select-all">{c.code}</code>
                  {c.redemptions?.length ? (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer">
                        {t("兑换记录")}
                      </summary>
                      {c.redemptions.map((r, i) => (
                        <p className="mt-2" key={i}>
                          {r.playerDisplayName} · {date(r.redeemedAt)}
                        </p>
                      ))}
                    </details>
                  ) : null}
                </td>
                <td className={cell}>
                  {presents.data?.presents.find((p) => p.id === c.presentId)
                    ?.name ?? "—"}
                </td>
                <td className={cell}>
                  {c.usageCount} / {c.maxUseCount}
                </td>
                <td className={`${cell} whitespace-nowrap`}>
                  {date(c.expiresAt)}
                </td>
                <td className={cell}>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={button}
                      onClick={() => setDetail({ kind: "code", item: c })}
                    >
                      {t("详情")}
                    </button>
                    {canWrite && (
                      <button
                        className={button}
                        onClick={() =>
                          setConfirmation({
                            name: c.code,
                            path: `redeem-codes/${segment(c.id)}/revoke`,
                          })
                        }
                      >
                        {t("撤销")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        ))}
      {detail && (
        <Modal
          title={
            {
              asset: "资产详情",
              effect: "优惠详情",
              present: "礼物详情",
              code: "兑换码详情",
            }[detail.kind]
          }
          close={() => setDetail(null)}
        >
          {detail.kind === "asset" && (
            <AssetDetails
              asset={detail.item}
              effects={effects.data?.pricingEffects ?? []}
            />
          )}
          {detail.kind === "effect" && <EffectDetails effect={detail.item} />}
          {detail.kind === "present" && (
            <PresentDetails
              present={detail.item}
              assets={assets.data?.assetDefinitions ?? []}
            />
          )}
          {detail.kind === "code" && (
            <RedeemCodeDetails
              code={detail.item}
              presents={presents.data?.presents ?? []}
              assets={assets.data?.assetDefinitions ?? []}
            />
          )}
        </Modal>
      )}
      {editing && (
        <Modal
          title={creatingAsset ? "新建资产" : "编辑资产"}
          close={() => setEditing(null)}
          wide
        >
          <ActionForm
            done={() => {
              setEditing(null);
              reload();
            }}
            submit={(f) => {
              if (
                creatingAsset &&
                assets.data?.assetDefinitions.some(
                  (a) => a.type === editing.type && a.code === editing.code,
                )
              )
                throw new Error(t("资产编号已存在"));
              return request(
                `asset-definitions/${segment(editing.type)}/${segment(editing.code)}`,
                "PUT",
                {
                  ...editing,
                  name: f.get("name"),
                  stackable: f.get("stackable") === "on",
                  pricingEffectId: f.get("effect") || null,
                },
              );
            }}
          >
            <section className="grid gap-3">
              <h3 className="text-sm font-semibold">{t("基本信息")}</h3>
              <Field label="名称">
                <input
                  className={input}
                  name="name"
                  required
                  defaultValue={editing.name}
                />
              </Field>
              {creatingAsset && (
                <fieldset className="grid gap-2">
                  <legend className="mb-1 text-sm font-medium">{t("类型")}</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(
                      [
                        ["currency", "余额", "玩家充值得到的钱，结账时扣除"],
                        ["coupon", "权益", "券或次数，按用途发放"],
                      ] as const
                    ).map(([value, label, hint]) => (
                      <label
                        key={value}
                        className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${
                          editing.type === value
                            ? "border-mint/50 bg-mint/[0.04]"
                            : "border-ink/15"
                        }`}
                      >
                        <input
                          type="radio"
                          name="assetType"
                          className="mt-0.5"
                          checked={editing.type === value}
                          onChange={() =>
                            setEditing({
                              ...editing,
                              type: value,
                              code:
                                value === "currency"
                                  ? "paid"
                                  : crypto.randomUUID(),
                            })
                          }
                        />
                        <span className="min-w-0">
                          <strong className="block font-medium">{t(label)}</strong>
                          <span className="mt-0.5 block text-xs text-ink/55">
                            {t(hint)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </section>
            <section className="grid gap-3">
              <h3 className="text-sm font-semibold">{t("计价与叠加")}</h3>
              <Field label="优惠">
                <select
                  className={input}
                  name="effect"
                  defaultValue={editing.pricingEffectId ?? ""}
                >
                  <option value="">{t("无")}</option>
                  {effects.data?.pricingEffects
                    .filter(
                      (e) =>
                        e.status !== "archived" ||
                        e.id === editing.pricingEffectId,
                    )
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                        {e.status === "archived" ? ` · ${t("已归档")}` : ""}
                      </option>
                    ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  name="stackable"
                  type="checkbox"
                  defaultChecked={editing.stackable}
                />
                {t("数量可叠加（同一玩家可以持有多份）")}
              </label>
            </section>
          </ActionForm>
        </Modal>
      )}
      {effect && (
        <Modal title="优惠" close={() => setEffect(null)}>
          <ActionForm
            done={() => {
              setEffect(null);
              reload();
            }}
            submit={(f) =>
              request(
                `pricing-effects/${segment(effect.id || crypto.randomUUID())}`,
                "PUT",
                {
                  ...effect,
                  name: f.get("name"),
                  type: f.get("type"),
                  scope: f.get("scope"),
                  value:
                    f.get("type") === "free" ? null : Number(f.get("value")),
                  consumable: f.get("consumable") === "on",
                  limitPerDay: f.get("limit") ? Number(f.get("limit")) : null,
                },
              )
            }
          >
            <Field label="名称">
              <input
                className={input}
                name="name"
                required
                defaultValue={effect.name}
              />
            </Field>
            <Field label="优惠方式">
              <select className={input} name="type" defaultValue={effect.type}>
                {[
                  ["free", "免费"],
                  ["discount", "减免金额"],
                  ["percentage-discount", "折扣比例"],
                  ["surcharge", "加收金额"],
                ].map(([key, label]) => (
                  <option key={key} value={key}>
                    {t(label!)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="数值（比例减免使用 0～100）">
              <input
                className={input}
                type="number"
                min="0"
                step="0.01"
                name="value"
                defaultValue={effect.value ?? 0}
              />
            </Field>
            <Field label="范围">
              <select
                className={input}
                name="scope"
                defaultValue={effect.scope}
              >
                <option value="unified">{t("整笔账单")}</option>
                <option value="session">{t("单项消费")}</option>
              </select>
            </Field>
            <Field label="每日使用上限">
              <input
                className={input}
                name="limit"
                type="number"
                min="1"
                step="1"
                defaultValue={effect.limitPerDay ?? ""}
              />
            </Field>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                name="consumable"
                defaultChecked={effect.consumable}
              />
              {t("使用后扣除")}
            </label>
          </ActionForm>
        </Modal>
      )}
      {gift && (
        <Modal title="添加礼物" close={() => setGift(false)}>
          <GiftForm
            assets={assets.data?.assetDefinitions ?? []}
            done={() => {
              setGift(false);
              reload();
            }}
          />
        </Modal>
      )}
      {code && (
        <Modal title="生成兑换码" close={() => setCode(false)}>
          <ActionForm
            done={() => {
              setCode(false);
              reload();
            }}
            label="生成"
            submit={(f) =>
              request("redeem-codes/batch", "POST", {
                presentId: f.get("present"),
                prefix: f.get("prefix"),
                count: Number(f.get("count")),
                maxUseCount: Number(f.get("uses")),
                activeAt: null,
                expiresAt: f.get("expires")
                  ? parseLocalDateTime(
                      String(f.get("expires")).slice(0, 10),
                      String(f.get("expires")).slice(11, 16),
                      timeZone,
                    ).toISOString()
                  : null,
              })
            }
          >
            <Field label="礼物">
              <select className={input} required name="present" defaultValue="">
                <option value="" disabled>
                  {t("请选择")}
                </option>
                {presents.data?.presents
                  .filter((p) => p.status !== "archived")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="前缀">
              <input className={input} name="prefix" maxLength={24} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="生成数量">
                <input
                  className={input}
                  name="count"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  defaultValue="1"
                  required
                />
              </Field>
              <Field label="每码可用次数">
                <input
                  className={input}
                  name="uses"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue="1"
                  required
                />
              </Field>
            </div>
            <Field label="到期时间">
              <input className={input} type="datetime-local" name="expires" />
            </Field>
          </ActionForm>
        </Modal>
      )}
      {confirmation && (
        <Modal title="确认操作" close={() => setConfirmation(null)}>
          <ActionForm
            label="确认"
            done={() => {
              setConfirmation(null);
              reload();
            }}
            submit={() => request(confirmation.path, "POST", {})}
          >
            <p>{confirmation.name}</p>
          </ActionForm>
        </Modal>
      )}
    </div>
  );
}
function Empty({ title }: { title: string }) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-dashed border-ink/20 px-6 py-14 text-center">
      <p className="font-medium">{t(title)}</p>
    </div>
  );
}

function GiftForm({ assets, done }: { assets: Asset[]; done: () => void }) {
  const { t } = useI18n();
  const request = useStaffApi();
  const [grants, setGrants] = useState<Grant[]>([
    {
      assetType: "",
      assetCode: "",
      amount: 1,
      mergeStrategy: "stack",
      activeAt: null,
      expiresAt: null,
    },
  ]);
  return (
    <ActionForm
      done={done}
      submit={(f) =>
        request("presents", "POST", {
          name: f.get("name"),
          oncePerPlayer: f.get("once") === "on",
          activeAt: null,
          expiresAt: null,
          grants,
        })
      }
    >
      <Field label="名称">
        <input className={input} name="name" required />
      </Field>
      <label className="flex gap-2 text-sm">
        <input type="checkbox" name="once" defaultChecked />
        {t("每位玩家仅限一次")}
      </label>
      {grants.map((g, index) => (
        <div
          className="grid grid-cols-[1fr_6rem_auto] items-end gap-2"
          key={index}
        >
          <Field label="资产">
            <select
              className={input}
              required
              value={`${g.assetType}|${g.assetCode}`}
              onChange={(e) => {
                const [assetType, assetCode] = e.target.value.split("|");
                setGrants(
                  grants.map((v, i) =>
                    i === index
                      ? { ...v, assetType: assetType!, assetCode: assetCode! }
                      : v,
                  ),
                );
              }}
            >
              <option value="|" disabled>
                {t("请选择")}
              </option>
              {assets
                .filter((a) => a.status !== "archived")
                .map((a) => (
                  <option
                    key={`${a.type}:${a.code}`}
                    value={`${a.type}|${a.code}`}
                  >
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="数量">
            <input
              className={input}
              type="number"
              min="0.01"
              step="0.01"
              value={g.amount}
              required
              onChange={(e) =>
                setGrants(
                  grants.map((v, i) =>
                    i === index ? { ...v, amount: Number(e.target.value) } : v,
                  ),
                )
              }
            />
          </Field>
          <button
            type="button"
            className={button}
            disabled={grants.length === 1}
            onClick={() => setGrants(grants.filter((_, i) => i !== index))}
          >
            {t("移除")}
          </button>
        </div>
      ))}
      <button
        type="button"
        className={button}
        onClick={() =>
          setGrants([
            ...grants,
            {
              assetType: "",
              assetCode: "",
              amount: 1,
              mergeStrategy: "stack",
              activeAt: null,
              expiresAt: null,
            },
          ])
        }
      >
        {t("添加资产")}
      </button>
    </ActionForm>
  );
}
