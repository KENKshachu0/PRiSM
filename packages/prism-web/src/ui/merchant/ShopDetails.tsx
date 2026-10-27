import { useI18n } from "../../i18n";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { resolveLocationTimeZone } from "@prism/core";
import { Plus, Save, Trash2 } from "lucide-react";
import { api, Api, type Shop, type ShopMember } from "../../api";
import { input, button, primary, useMerchant, segment } from "./shared";
import { MapPicker } from "../MapPicker";
import { ShopHeroEditor } from "../ShopHeroEditor";

export function ShopForm({
  shop,
  onSaved,
  back,
  billingSetup,
}: {
  shop?: Shop | null;
  billingSetup?: Record<string, unknown>;
  onSaved: (shop: Shop, token?: string) => void | Promise<void>;
  /** Shown beside save when the form is the last step of a wizard. */
  back?: () => void;
}) {
  const { t, errorText } = useI18n();
  const [name, setName] = useState(shop?.name ?? "");
  const [heroData, setHeroData] = useState<string | null | undefined>(
    undefined,
  );
  const [latitude, setLatitude] = useState<number | null>(
    shop?.latitude ?? null,
  );
  const [longitude, setLongitude] = useState<number | null>(
    shop?.longitude ?? null,
  );
  const timeZone = useMemo(() => {
    if (latitude === null || longitude === null) return null;
    try { return resolveLocationTimeZone(latitude, longitude); }
    catch { return null; }
  }, [latitude, longitude]);
  const [radiusMeters, setRadiusMeters] = useState(
    String(shop?.radiusMeters ?? shop?.radius_meters ?? 80),
  );
  const [heroBusy, setHeroBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shop) {
      setName(shop.name);
      setHeroData(undefined);
      setLatitude(shop.latitude);
      setLongitude(shop.longitude);
      setRadiusMeters(String(shop.radiusMeters ?? shop.radius_meters ?? 80));
    }
  }, [shop]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (latitude === null || longitude === null || !timeZone) {
      setError("请在地图上选择或填写店铺位置");
      return;
    }
    const radius = Number(radiusMeters);
    if (!Number.isFinite(radius) || radius < 30 || radius > 1000) {
      setError("店铺定位范围必须在 30 到 1000 米之间");
      return;
    }
    if (heroBusy) {
      setError("请先完成封面裁剪");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (shop) {
        const result = await Api.updateShop(shop.id, {
          name,
          ...(heroData !== undefined ? { heroData } : {}),
          latitude,
          longitude,
          radiusMeters: radius,
        });
        window.dispatchEvent(new Event("prism-shop-settings"));
        await onSaved(result.shop);
      } else {
        const result = await api<{ shop: Shop; botToken: string | null }>(
          "/api/v1/merchant/shops",
          {
            method: "POST",
            body: JSON.stringify({
              billingSetup,
              name,
              ...(heroData !== undefined ? { heroData } : {}),
              latitude,
              longitude,
              radiusMeters: radius,
            }),
          },
        );
        setName("");
        setHeroData(null);
        setLatitude(null);
        setLongitude(null);
        setRadiusMeters("80");
        await onSaved(result.shop, result.botToken ?? undefined);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存店铺失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {error && (
        <p role="alert" className="mb-4 rounded border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">
          {errorText(error)}
        </p>
      )}
      <div className="grid gap-4">
        <label className="grid gap-1.5 text-sm font-medium">
          {t("店铺名称")}
          <input
            className={input}
            placeholder={t("万达广场机厅")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>

        <ShopHeroEditor
          key={shop?.id ?? "new"}
          value={heroData === undefined ? (shop?.heroUrl ?? null) : heroData}
          onChange={setHeroData}
          onBusy={setHeroBusy}
        />

        <div>
          <span className="mb-1.5 block text-sm font-medium">
            {t("店铺位置")}
          </span>
          <MapPicker
            latitude={latitude}
            longitude={longitude}
            onChange={(lat, lng) => {
              setLatitude(lat);
              setLongitude(lng);
            }}
          />
          <div className="mt-2 grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-xs text-ink/70">
              {t("纬度 (Latitude)")}
              <input
                className={`${input} font-mono`}
                value={latitude ?? ""}
                onChange={(event) =>
                  setLatitude(parseCoordinate(event.target.value))
                }
                required
              />
            </label>
            <label className="grid gap-1 text-xs text-ink/70">
              {t("经度 (Longitude)")}
              <input
                className={`${input} font-mono`}
                value={longitude ?? ""}
                onChange={(event) =>
                  setLongitude(parseCoordinate(event.target.value))
                }
                required
              />
            </label>
          </div>
          <div className="mt-3 grid gap-1.5 text-sm">
            <p role="status" className="font-medium">
              {t("店铺时区（随位置自动设置）")}：{" "}
              <span className="font-mono font-normal">{timeZone ?? t("选择位置后自动识别")}</span>
            </p>
            <p className="text-xs text-ink/50">
              {t("时区根据店铺位置自动识别，用于时间展示和规则编辑；计费统一使用 UTC。")}
            </p>
          </div>
        </div>

        <label className="grid gap-1.5 text-sm font-medium">
          <div className="flex items-center justify-between">
            <span>{t("店铺定位范围")}</span>
            <span className="text-xs font-normal text-ink/50">
              {t("30 ~ 1000 米")}
            </span>
          </div>
          <div className="relative">
            <input
              type="number"
              min={30}
              max={1000}
              className={`${input} pr-10`}
              value={radiusMeters}
              onChange={(event) => setRadiusMeters(event.target.value)}
              inputMode="numeric"
              required
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink/50">
              {t("米")}
            </span>
          </div>
          <span className="text-xs font-normal text-ink/50">
            {t(
              "以地图标记为中心；范围内允许入场和设备操作，离场结账需确认在范围外。",
            )}
          </span>
        </label>
        <div className="flex flex-wrap justify-between gap-3">
          {back && (
            <button type="button" className={button} onClick={back}>
              {t("上一步")}
            </button>
          )}
          <button className={primary} disabled={busy || heroBusy}>
            {shop ? <Save size={18} /> : <Plus size={18} />}
            {t(busy ? "处理中…" : shop ? "保存修改" : "创建店铺")}
          </button>
        </div>
      </div>
    </form>
  );
}

function parseCoordinate(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function MembersPanel({
  shopId,
  members,
  onChanged,
}: {
  shopId: string;
  members: ShopMember[];
  onChanged: () => void | Promise<void>;
}) {
  const { t, errorText } = useI18n();
  const { shopCode } = useMerchant();
  const [permissions, setPermissions] = useState<Record<string, string>>({});
  const [savingMember, setSavingMember] = useState("");
  useEffect(() => {
    let active = true;
    api<{ members: { userId: string; billingRole: string }[] }>(
      `/api/v1/shops/${segment(shopCode)}/billing-members`,
    ).then((result) => {
      if (active) setPermissions(Object.fromEntries(result.members.map((m) => [m.userId, m.billingRole])));
    }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [shopCode, members]);
  const [memberUser, setMemberUser] = useState("");
  const [role, setRole] = useState<ShopMember["role"]>("staff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await Api.addShopMember({ shopId, user: memberUser, role });
      setMemberUser("");
      setRole("staff");
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "添加成员失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-ink/10 bg-panel p-5">
      <h3 className="font-semibold">{t("店铺成员")}</h3>
      {error && (
        <p className="mt-3 rounded border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">
          {errorText(error)}
        </p>
      )}
      <form className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={submit}>
        <input
          className={input}
          aria-label={t("MuNET 用户名或 ID")}
          placeholder={t("MuNET 用户名或 ID")}
          value={memberUser}
          onChange={(event) => setMemberUser(event.target.value)}
          required
        />
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <select
            className={input}
            aria-label={t("店铺角色")}
            value={role}
            onChange={(event) =>
              setRole(event.target.value as ShopMember["role"])
            }
          >
            <option value="staff">{t("店员")}</option>
            <option value="owner">{t("负责人")}</option>
          </select>
          <button
            className={button}
            disabled={busy}
          >
            {t("添加")}
          </button>
        </div>
      </form>
      <div className="mt-5 divide-y divide-ink/10">
        {members.map((member) => (
          <div
            key={member.id}
            className="flex flex-wrap items-center justify-between gap-3 py-4"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{member.displayName}</p>
              <p className="text-sm text-ink/60">
                @{member.username} ·{" "}
                {member.role === "owner" ? t("负责人") : t("店员")}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {member.role !== "owner" && (
                <label className="grid gap-1 text-xs text-ink/60">
                  {t("计费权限")}
                  <select
                    className={input}
                    disabled={savingMember === member.userId || permissions[member.userId] === undefined}
                    value={permissions[member.userId] ?? "none"}
                    onChange={async (e) => {
                      const role = e.target.value;
                      setSavingMember(member.userId);
                      setError(null);
                      try {
                        await api(`/api/v1/shops/${segment(shopCode)}/billing-members/${segment(member.userId)}`, {
                          method: "PUT",
                          body: JSON.stringify({ role }),
                        });
                        setPermissions((current) => ({ ...current, [member.userId]: role }));
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "保存失败");
                      } finally { setSavingMember(""); }
                    }}
                  >
                    <option value="none">{t("无")}</option>
                    <option value="viewer">{t("只读")}</option>
                    <option value="manager">{t("管理")}</option>
                  </select>
                </label>
              )}
            <button
              type="button"
              title={t("移除成员")}
              aria-label={t("移除成员")}
              className="focus-ring grid size-9 shrink-0 place-items-center rounded text-coral hover:bg-coral/10"
              onClick={async () => {
                setError(null);
                try {
                  await Api.removeShopMember(member.id);
                  await onChanged();
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : "保存失败");
                }
              }}
            >
              <Trash2 size={16} />
            </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
