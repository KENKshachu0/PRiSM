import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AirVent,
  ChevronDown,
  CreditCard,
  DoorOpen,
  Power,
  Ungroup,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, type Machine } from "../../api";
import { useI18n } from "../../i18n";
import { ActionForm, Field, button, buttonQuiet, input, primary, useMerchant, useResource } from "./shared";
import { deviceCapabilities, type CapabilityId } from "./device-capabilities";
import { HaEntityFields, NEW_CONNECTION, haBody, useHaConnections, type HaDraft } from "./HaEntityFields";
import { idlePath, useIdleSettings } from "./IdlePowerSettings";

const draftOf = (binding?: { connectionId?: string | null; url: string; entityId: string } | null): HaDraft => ({
  connection: binding?.connectionId ?? NEW_CONNECTION,
  url: binding?.url ?? "",
  token: "",
  entityId: binding?.entityId ?? "",
});
const POWER_DOMAINS = ["switch", "input_boolean"];
const CLIMATE_DOMAINS = ["climate"];

/**
 * Device configuration in two sections: what the device *is* (identity) and
 * what it *can do* (capabilities). Capabilities start collapsed and open one
 * at a time, so a device with four bindings is not a wall of credentials; the
 * switch turns a capability on, and turning it on opens it, because that is
 * the moment its configuration has to be filled in.
 */
export function DeviceEditor({
  value,
  done,
  onLockChange,
}: {
  value?: Machine;
  done: () => void;
  /** Locks the dialog while a one-time token is on screen. */
  onLockChange: (locked: boolean) => void;
}) {
  const { shopId, shopCode, billingEnabled, owner } = useMerchant();
  const { t } = useI18n();
  const shopSettings = useResource<{
    settings: { ttLockConnection?: Record<string, string | undefined> | null };
  }>(owner ? "settings" : null);
  const lock = shopSettings.data?.settings.ttLockConnection;
  const ttLockMissing =
    !!shopSettings.data &&
    !(lock?.clientId && lock.clientSecret && (lock.accessToken || lock.appAccount));
  const shopPath = `/merchant/${encodeURIComponent(shopCode)}`;
  const initial = deviceCapabilities(
    value ?? {
      homeAssistant: null,
      climate: null,
      ttlockLockId: null,
      mahjong: null,
      hasHinata: false,
      relayConnection: "external",
      coinEnabled: false,
      hasPassword: false,
    },
  );
  const [caps, setCaps] = useState(initial);
  // Every capability starts collapsed; selecting one opens it, and only one
  // stays open at a time.
  const [open, setOpen] = useState<CapabilityId | null>(null);
  const [name, setName] = useState(value?.name ?? "");
  // One value per alias. The editor always renders one extra empty row, so an
  // empty array is the correct starting point for a device without aliases.
  const [aliases, setAliases] = useState<string[]>(value?.aliases ?? []);
  const [enabled, setEnabled] = useState(value ? !!value.enabled : true);

  const ha = useHaConnections(shopId);
  const idle = useIdleSettings(shopId);
  const ownIdle = value ? idle.settings?.devices[value.id] : undefined;
  const [idleMinutes, setIdleMinutes] = useState("");
  const [idleExclude, setIdleExclude] = useState(false);
  useEffect(() => {
    setIdleMinutes(ownIdle?.minutes == null ? "" : String(ownIdle.minutes));
    setIdleExclude(!!ownIdle?.exclude);
  }, [ownIdle?.minutes, ownIdle?.exclude]);
  const [power, setPower] = useState<HaDraft>(() => draftOf(value?.homeAssistant));
  const [ac, setAc] = useState<HaDraft>(() => draftOf(value?.climate));
  // Once the shop's connections are known, an unset binding uses the first one,
  // and one saved by address alone is shown on its connection.
  useEffect(() => {
    const list = ha.connections;
    if (!list?.length) return;
    const settle = (draft: HaDraft): HaDraft => {
      if (draft.connection !== NEW_CONNECTION || draft.token) return draft;
      const url = draft.url.trim().replace(/\/+$/, "");
      const match = url ? list.find((connection) => connection.url === url) : list[0];
      return match ? { ...draft, connection: match.id } : draft;
    };
    setPower(settle);
    setAc(settle);
  }, [ha.connections]);
  // The server reuses the power side's token for the same new Home Assistant.
  const acSharesPowerToken =
    caps.power && ac.connection === NEW_CONNECTION && power.connection === NEW_CONNECTION &&
    !!ac.url.trim() && ac.url.trim() === power.url.trim() && (!!value?.homeAssistant || !!power.token.trim());

  const [embedded, setEmbedded] = useState(
    value?.relayConnection === "embedded",
  );
  const [hinataUrl, setHinataUrl] = useState(value?.hinataUrl ?? "");
  const [password, setPassword] = useState("");
  const [coinKey, setCoinKey] = useState(
    value?.coinKey ? String(value.coinKey) : "",
  );
  const [coinAfterSwipe, setCoinAfterSwipe] = useState(
    value?.coinAfterSwipe ?? false,
  );

  const [lockId, setLockId] = useState(
    value?.ttlockLockId ? String(value.ttlockLockId) : "",
  );
  const [capacity, setCapacity] = useState(
    String(value?.mahjong?.capacity ?? 4),
  );
  const [mahjongPricing, setMahjongPricing] = useState<string[]>(
    value?.mahjong?.pricingConfigIds ?? [],
  );
  const [pricing, setPricing] = useState<
    { id: string; name: string; enabled: boolean }[]
  >([]);

  const [issued, setIssued] = useState<{ token: string; url: string } | null>(
    null,
  );
  const [live, setLive] = useState<Machine | null>(value ?? null);
  const canCoin = embedded || !!value?.hasPassword || !!password;

  useEffect(() => {
    if (!caps.mahjong) return;
    api<{ pricingConfigs: typeof pricing }>(
      `/api/v1/shops/${encodeURIComponent(shopCode)}/staff/pricing-configs`,
    )
      .then((r) => setPricing(r.pricingConfigs))
      .catch(() => setPricing([]));
  }, [caps.mahjong, shopCode]);

  // A token that is on screen has not reached the machine yet, so the dialog
  // must stay open until the store confirms it wrote the value down.
  useEffect(() => {
    onLockChange(!!issued);
    return () => onLockChange(false);
  }, [issued, onLockChange]);

  /** Why a capability's own configuration is not complete yet. */
  const missingConfig = (id: CapabilityId): string | null => {
    if (id === "power") {
      if (power.connection === NEW_CONNECTION && !power.url.trim()) return t("请填写 Home Assistant 地址");
      if (!power.entityId.trim()) return t("请填写电源实体");
      if (power.connection === NEW_CONNECTION && !value?.homeAssistant && !power.token.trim())
        return t("请填写长期访问令牌");
    }
    if (id === "climate") {
      if (ac.connection === NEW_CONNECTION && !ac.url.trim()) return t("请填写 Home Assistant 地址");
      if (!/^climate\.[a-z0-9_]+$/.test(ac.entityId.trim()))
        return t("请填写 climate. 开头的空调实体");
      if (ac.connection === NEW_CONNECTION && !value?.climate && !ac.token.trim() && !acSharesPowerToken)
        return t("请填写长期访问令牌");
    }
    if (id === "hinata_io" && !embedded && !hinataUrl.trim())
      return t("请填写 HINATA IO 地址");
    if (id === "door" && !(Number(lockId) > 0)) return t("请填写门锁 ID");
    if (id === "mahjong") {
      const seats = Number(capacity);
      if (!Number.isInteger(seats) || seats < 2 || seats > 8)
        return t("开桌人数需要在 2 到 8 之间");
    }
    return null;
  };

  /**
   * Turning a capability on only opens it when there is still something to
   * fill in; a capability that is already configured is just switched on.
   * Turning it off closes it.
   */
  const toggle = (id: CapabilityId, on: boolean) => {
    setCaps((current) => ({ ...current, [id]: on }));
    if (!on) {
      setOpen((current) => (current === id ? null : current));
      return;
    }
    if (missingConfig(id)) setOpen(id);
  };

  /** Why an enabled capability still cannot be saved, if it cannot. */
  const incomplete = (id: CapabilityId): string | null =>
    caps[id] ? missingConfig(id) : null;

  /** The INI fragment a machine needs to reach this platform directly. */
  const iniSnippet = issued
    ? `serverUrl=${issued.url}\ndeviceToken=${issued.token}`
    : "";

  if (issued) {
    // The token is a one-time credential handout, not part of the form. The
    // dialog stays locked until the store confirms it wrote the value down.
    return (
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h3 className="text-sm font-semibold">{t("设备令牌已签发")}</h3>
          <p className="text-xs leading-relaxed text-ink/60">
            {t("这是唯一一次显示，离开后无法再次查看。")}
          </p>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t("设备令牌")}</span>
            <CopyButton value={issued.token} label="复制令牌" />
          </div>
          <code className="break-all rounded-lg bg-ink/5 p-3 text-xs">
            {issued.token}
          </code>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t("写入机台 INI")}</span>
            <CopyButton value={iniSnippet} label="复制片段" />
          </div>
          <pre className="overflow-x-auto whitespace-pre rounded-lg bg-ink/5 p-3 text-xs">
            {iniSnippet}
          </pre>
          <p className="text-xs leading-relaxed text-ink/60">
            {t("把这两行写入 hinata.ini 或 segatools.ini 的 [aimeio] 段，然后重启机台。")}
          </p>
        </div>
        <button
          type="button"
          className={`${primary} justify-self-start`}
          onClick={() => {
            setIssued(null);
            done();
          }}
        >
          {t("我已写入机台")}
        </button>
      </div>
    );
  }

  return (
    <ActionForm
      sticky
      noValidate
      done={done}
      onResult={(result) => {
        // The device token is returned exactly once. Keep the editor open so
        // the store can copy it, and never re-fetch it: it is not recoverable.
        const saved = result as {
          machine?: Machine;
          relayToken?: string;
        } | null;
        if (saved?.machine) setLive(saved.machine);
        const token = saved?.relayToken;
        if (!token) {
          setIssued(null);
          return false;
        }
        setIssued({ token, url: saved?.machine?.relayUrl ?? "" });
        return true;
      }}
      submit={async (f) => {
        const issuing = f.get("intent") === "issue";
        if (!name.trim()) throw new Error(t("请填写设备名称"));
        for (const id of ["power", "climate", "hinata_io", "door", "mahjong"] as const) {
          const reason = incomplete(id);
          if (reason) {
            // Open the card so the precise message lands next to the field
            // that needs attention; the form-level notice only points at it.
            setOpen(id);
            // The card may be below the fold, so bring it into view once the
            // expansion has rendered.
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                document
                  .querySelector(
                    `dialog[open] [data-capability="${id}"]`,
                  )
                  ?.scrollIntoView({ block: "nearest" });
              });
            });
            throw new Error(t("请先补全标记为「待配置」的能力。"));
          }
        }
        // Minting is an explicit action. A plain save on a direct-connect
        // device without a credential would silently create one, so it is
        // refused instead.
        if (
          caps.hinata_io &&
          embedded &&
          !live?.hasRelayToken &&
          !issuing
        ) {
          setOpen("hinata_io");
          throw new Error(t("请先签发设备令牌，或改为外部中继。"));
        }
        const saved = await api<{ machine: Machine }>(`/api/v1/merchant/machines${value ? `/${value.id}` : ""}`, {
          method: value ? "PATCH" : "POST",
          body: JSON.stringify({
            shopId,
            name: name.trim(),
            aliases: aliases
              .map((alias) => alias.trim())
              .filter(Boolean),
            kind: caps.door ? "door" : "machine",
            enabled,
            mahjong: caps.mahjong
              ? {
                  capacity: Number(capacity),
                  pricingConfigIds: mahjongPricing,
                }
              : null,
            // A capability that is switched off is removed, which the server
            // expresses as `null` for the bound fields.
            relayConnection: caps.hinata_io && embedded ? "embedded" : "external",
            // Re-issuing replaces the token the machine currently uses.
            ...(caps.hinata_io && embedded && issuing && live?.hasRelayToken
              ? { rotateRelayToken: true }
              : {}),
            // Direct mode is authenticated by its device token, so it has no URL
            // or password to send, and the platform rejects the combination.
            hinataUrl: caps.hinata_io && !embedded ? hinataUrl.trim() : null,
            ...(caps.hinata_io && !embedded && password
              ? { hinataPassword: password }
              : {}),
            homeAssistant: caps.power ? haBody(power) : null,
            climate: caps.climate ? haBody(ac) : null,
            coinKey: caps.hinata_io && canCoin ? Number(coinKey || 0) : 0,
            coinAfterSwipe:
              caps.hinata_io &&
              canCoin &&
              Number(coinKey) > 0 &&
              coinAfterSwipe,
            ttlockLockId: caps.door ? Number(lockId) : null,
          }),
        });
        // Idle settings live with the shop's rules, keyed by device.
        const own = idle.settings?.devices[saved.machine.id];
        const minutes = idleMinutes.trim() === "" ? null : Number(idleMinutes);
        if (caps.power && ((own?.minutes ?? null) !== minutes || !!own?.exclude !== idleExclude)) {
          await api(idlePath(shopId, `/devices/${encodeURIComponent(saved.machine.id)}`), {
            method: "PUT",
            body: JSON.stringify({ minutes, exclude: idleExclude }),
          });
        }
        return saved;
      }}
    >
      <section className="grid gap-3">
        <h3 className="text-sm font-semibold">{t("设备身份")}</h3>
        <Field label="设备名称">
          <input
            autoFocus
            className={input}
            value={name}
            required
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid gap-2">
          <div>
            <span className="text-sm font-medium">{t("设备别名")}</span>
            <p className="mt-1 text-xs text-ink/50">
              {t("玩家和 Bot 可以用任意一个别名找到这台设备。")}
            </p>
          </div>
          {/* The list always ends in an empty row: typing in it appends the
              value and a fresh empty row appears, so adding an alias needs no
              separate button. */}
          {[...aliases, ""].map((alias, index) => {
            const draft = index === aliases.length;
            return (
              <div className="flex items-center gap-2" key={index}>
                <input
                  className={input}
                  value={alias}
                  aria-label={`${t("设备别名")} ${index + 1}`}
                  maxLength={80}
                  autoComplete="off"
                  onChange={(e) => {
                    const next = e.target.value;
                    if (index < aliases.length) {
                      setAliases(
                        aliases.map((current, i) =>
                          i === index ? next : current,
                        ),
                      );
                    } else if (next) {
                      setAliases([...aliases, next]);
                    }
                  }}
                  onBlur={() => {
                    // An alias edited down to nothing should not leave a
                    // blank row behind when the field loses focus.
                    if (index < aliases.length && !aliases[index]?.trim()) {
                      setAliases(aliases.filter((_, i) => i !== index));
                    }
                  }}
                />
                {!draft && (
                  <button
                    type="button"
                    className={`${buttonQuiet} size-11 shrink-0 justify-center`}
                    aria-label={`${t("移除别名")} ${index + 1}`}
                    onClick={() =>
                      setAliases(aliases.filter((_, i) => i !== index))
                    }
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t("启用设备（停用后玩家扫码无法使用）")}
        </label>
      </section>

      <section className="grid gap-3">
        <h3 className="text-sm font-semibold">{t("设备能力")}</h3>

        <CapabilityCard
          id="power"
          icon={Power}
          title="电源控制"
          description="通过 Home Assistant 读取并开关机台电源。"
          summary={power.entityId.trim()}
          on={caps.power}
          open={open === "power"}
          toggle={(on) => toggle("power", on)}
          select={() => setOpen(open === "power" ? null : "power")}
          problem={incomplete("power")}
        >
          <HaEntityFields
            shopId={shopId}
            connections={ha.connections ?? []}
            draft={power}
            change={setPower}
            domains={POWER_DOMAINS}
            entityLabel="电源实体"
            entityPlaceholder="switch.maimai"
            tokenOptional={!!value?.homeAssistant}
            reload={ha.reload}
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="设备闲置判定时长覆盖" unit="分钟">
              <input
                className={input}
                type="number"
                min="0"
                max="1440"
                disabled={idleExclude}
                placeholder={t("店铺默认（{minutes}）", { minutes: idle.settings?.device.defaultMinutes ?? 0 })}
                value={idleMinutes}
                onChange={(e) => setIdleMinutes(e.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 self-end pb-3 text-sm">
              <input type="checkbox" checked={idleExclude} onChange={(e) => setIdleExclude(e.target.checked)} />
              {t("从不自动关机")}
            </label>
          </div>
        </CapabilityCard>

        <CapabilityCard
          id="climate"
          icon={AirVent}
          title="空调"
          description="通过 Home Assistant 控制空调：开关、模式、温度和风速。"
          summary={ac.entityId.trim()}
          on={caps.climate}
          open={open === "climate"}
          toggle={(on) => {
            // Usually the same Home Assistant as the power switch.
            if (on && ac.connection === NEW_CONNECTION && !ac.url.trim())
              setAc({ ...ac, connection: power.connection, url: power.url });
            toggle("climate", on);
          }}
          select={() => setOpen(open === "climate" ? null : "climate")}
          problem={incomplete("climate")}
        >
          <div className="grid gap-3">
            <HaEntityFields
              shopId={shopId}
              connections={ha.connections ?? []}
              draft={ac}
              change={setAc}
              domains={CLIMATE_DOMAINS}
              entityLabel="空调实体"
              entityPlaceholder="climate.living_room"
              tokenOptional={!!value?.climate || acSharesPowerToken}
              reload={ha.reload}
            />
            {acSharesPowerToken && !value?.climate && (
              <Hint>{t("与电源控制是同一个 Home Assistant，令牌可以留空，沿用电源的令牌。")}</Hint>
            )}
            <Hint>{t("可选的模式、风速和温度范围以空调实体自己上报的为准。")}</Hint>
          </div>
        </CapabilityCard>

        <CapabilityCard
          id="hinata_io"
          icon={CreditCard}
          title="刷卡 · HINATA IO"
          description="玩家刷卡启动机台、投币，或由机台直连本平台。"
          summary={
            caps.hinata_io
              ? [
                  t(embedded ? "直连本平台" : "外部中继"),
                  coinKey ? `${t("投币")} ${coinKey}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : ""
          }
          on={caps.hinata_io}
          open={open === "hinata_io"}
          toggle={(on) => toggle("hinata_io", on)}
          select={() => setOpen(open === "hinata_io" ? null : "hinata_io")}
          problem={incomplete("hinata_io")}
        >
          <div className="grid gap-4">
            <Segmented
              label={t("连接方式")}
              options={[
                ["external", t("外部中继")],
                ["embedded", t("直连本平台")],
              ]}
              value={embedded ? "embedded" : "external"}
              onChange={(next) => setEmbedded(next === "embedded")}
            />
            {embedded ? (
              <DirectConnectPanel
                live={live}
                hasRelayToken={!!live?.hasRelayToken}
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="HINATA IO 地址">
                  <input
                    className={input}
                    required
                    placeholder="https://io.example.com"
                    value={hinataUrl}
                    onChange={(e) => setHinataUrl(e.target.value)}
                  />
                </Field>
                <Field label="连接密码" unit={value?.hasPassword ? "已设置" : undefined}>
                  <input
                    className={input}
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    placeholder={
                      value?.hasPassword ? "••••••••" : ""
                    }
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
              </div>
            )}
            <div className="grid gap-3 border-t border-ink/10 pt-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="投币按键码">
                  <input
                    className={input}
                    type="number"
                    min="1"
                    max="65535"
                    placeholder={t("不启用")}
                    disabled={!canCoin}
                    value={coinKey}
                    onChange={(e) => setCoinKey(e.target.value)}
                  />
                </Field>
                <label className="flex items-end gap-2 pb-3 text-sm">
                  <input
                    type="checkbox"
                    disabled={!canCoin || !coinKey}
                    checked={coinAfterSwipe}
                    onChange={(e) => setCoinAfterSwipe(e.target.checked)}
                  />
                  {t("刷卡后自动投一币")}
                </label>
              </div>
              {!canCoin && (
                <Hint>{t("外部中继要先填连接密码，才能设置投币。")}</Hint>
              )}
              <Hint>
                {t("按键码使用 Windows Virtual-Key Codes，例如 32 是空格键。")}
              </Hint>
            </div>
          </div>
        </CapabilityCard>

        <CapabilityCard
          id="door"
          icon={DoorOpen}
          title="开门密码"
          description="通过 TTLock 生成一次性开门密码。"
          summary={lockId ? `TTLock · ${lockId}` : ""}
          on={caps.door}
          open={open === "door"}
          toggle={(on) => toggle("door", on)}
          select={() => setOpen(open === "door" ? null : "door")}
          problem={incomplete("door")}
        >
          <div className="grid gap-3">
            <Field label="TTLock 门锁 ID">
              <input
                className={input}
                type="number"
                min="1"
                step="1"
                required
                value={lockId}
                onChange={(e) => setLockId(e.target.value)}
              />
            </Field>
            {ttLockMissing ? (
              <p className="text-sm text-coral">
                {t("店铺还没有连接 TTLock 账号，开门会失败。")}{" "}
                <Link className="underline" to={`${shopPath}/settings?group=devices`}>
                  {t("去连接")}
                </Link>
              </p>
            ) : (
              <Hint>{t("TTLock 账号在「设置 → 位置与设备」中连接。")}</Hint>
            )}
          </div>
        </CapabilityCard>

        <CapabilityCard
          id="mahjong"
          icon={Ungroup}
          title="麻将桌"
          description="按座位开桌计时，与计费规则联动。"
          summary={
            caps.mahjong
              ? [
                  t("{count} 人", { count: capacity || "—" }),
                  mahjongPricing.length
                    ? t("{count} 条计费规则", {
                        count: mahjongPricing.length,
                      })
                    : t("未选择计费规则"),
                ].join(" · ")
              : ""
          }
          on={caps.mahjong}
          open={open === "mahjong"}
          toggle={(on) => toggle("mahjong", on)}
          select={() => setOpen(open === "mahjong" ? null : "mahjong")}
          problem={incomplete("mahjong")}
        >
          <div className="grid gap-3">
            <Field label="开桌人数">
              <input
                className={`${input} sm:max-w-[8rem]`}
                type="number"
                min="2"
                max="8"
                required
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </Field>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">
                {t("麻将计费规则")}
              </legend>
              {pricing.filter((r) => r.enabled).length === 0 ? (
                <p className="text-sm text-ink/55">
                  {billingEnabled
                    ? t("还没有启用中的计费规则。")
                    : t("麻将桌按座位计时收费，需要先启用入场计费。")}{" "}
                  <Link
                    className="underline"
                    to={billingEnabled ? `${shopPath}/pricing` : `${shopPath}/settings?group=billing`}
                  >
                    {t(billingEnabled ? "去「计费」页创建" : "启用入场计费")}
                  </Link>
                </p>
              ) : (
                <div className="grid gap-1">
                  {pricing
                    .filter((r) => r.enabled)
                    .map((r) => (
                      <label
                        className="flex items-center gap-2 text-sm"
                        key={r.id}
                      >
                        <input
                          type="checkbox"
                          checked={mahjongPricing.includes(r.id)}
                          onChange={(e) =>
                            setMahjongPricing(
                              e.target.checked
                                ? [...mahjongPricing, r.id]
                                : mahjongPricing.filter((id) => id !== r.id),
                            )
                          }
                        />
                        {r.name}
                      </label>
                    ))}
                </div>
              )}
              {billingEnabled && !mahjongPricing.length && (
                <p className="text-xs text-coral">
                  {t("请至少选择一条麻将计费规则。")}
                </p>
              )}
            </fieldset>
          </div>
        </CapabilityCard>
      </section>
    </ActionForm>
  );
}

/**
 * One capability: a header that opens it, a switch that enables it, and a body
 * that stays mounted but hidden while collapsed (so values survive collapse).
 * A capability that is on but not yet valid shows the reason in its header,
 * which is what makes a collapsed, half-filled card discoverable.
 */
function CapabilityCard({
  id,
  icon: Icon,
  title,
  description,
  summary,
  on,
  open,
  toggle,
  select,
  problem,
  children,
}: {
  id: CapabilityId;
  icon: LucideIcon;
  title: string;
  description: string;
  summary: string;
  on: boolean;
  open: boolean;
  toggle: (on: boolean) => void;
  select: () => void;
  problem: string | null;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div
      data-capability={id}
      className={`rounded-xl border transition-colors ${
        open
          ? "border-mint/40 bg-mint/[0.03]"
          : on
            ? "border-ink/15 bg-panel"
            : "border-ink/10 bg-panel"
      }`}
    >
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          className="focus-ring flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left"
          aria-expanded={open}
          onClick={select}
        >
          <span
            className={`grid size-9 shrink-0 place-items-center rounded-lg ${
              on ? "bg-mint/10 text-mint" : "bg-ink/5 text-ink/40"
            }`}
          >
            <Icon size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {t(title)}
              {problem && (
                <span className="rounded bg-coral/10 px-1.5 py-0.5 text-xs font-normal text-coral">
                  {t("待配置")}
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink/55">
              {on && summary ? summary : t(description)}
            </span>
          </span>
          <ChevronDown
            size={16}
            className={`mt-0.5 shrink-0 text-ink/35 transition-transform ${
              open ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </button>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-ink/60">
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={on}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span
            aria-hidden="true"
            className={`relative h-6 w-11 rounded-full transition-colors ${
              on ? "bg-mint" : "bg-ink/20"
            } after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-white after:transition-transform ${
              on ? "after:translate-x-5" : ""
            } peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-mint`}
          />
          <span>{t(on ? "已启用" : "未启用")}</span>
        </label>
      </div>
      <div
        hidden={!open}
        className="border-t border-ink/10 p-4"
        aria-label={t(title)}
      >
        {problem && (
          <p role="alert" className="mb-3 text-sm text-coral">
            {problem}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * Direct connect authenticates the machine with a token this platform issues.
 * Minting it is a separate, explicit action: a plain save must never hand the
 * store a secret it did not ask for. The button submits the form with
 * `intent=issue`, which is the only path that creates or rotates the token.
 */
function DirectConnectPanel({
  live,
  hasRelayToken,
}: {
  live: Machine | null;
  hasRelayToken: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3 rounded-lg border border-ink/10 bg-ink/[0.02] p-3">
      {live && (
        <p className="text-sm">
          <span className="text-ink/60">{t("连接状态")}：</span>
          {live.relayOnline === true ? (
            <span className="text-mint">{t("已连接")}</span>
          ) : live.relayOnline === false ? (
            <span className="text-coral">{t("未连接")}</span>
          ) : (
            <span className="text-ink/50">{t("未知")}</span>
          )}
        </p>
      )}
      {live?.relayUrl && (
        <p className="break-all text-xs text-ink/60">{`serverUrl=${live.relayUrl}`}</p>
      )}
      <button
        type="submit"
        name="intent"
        value="issue"
        className={`${button} justify-self-start`}
      >
        {t(hasRelayToken ? "轮换设备令牌" : "签发设备令牌")}
      </button>
      {hasRelayToken && (
        <p className="text-xs leading-relaxed text-coral">
          {t("轮换后机台上的旧令牌立即失效，需要把新令牌重新写入 INI。")}
        </p>
      )}
      {live?.relayE2ee === true && (
        <p className="text-sm text-coral">
          {t(
            "该机台仍在发送加密消息：请把机台 INI 里的 remotePassword 清空后重启，否则平台无法下发指令。",
          )}
        </p>
      )}
    </div>
  );
}

/** Copies a one-time value and confirms it, because selecting it by hand is error-prone. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`${buttonQuiet} min-h-9 px-2 text-xs`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access can be denied; the value stays selectable.
        }
      }}
    >
      {t(copied ? "已复制" : label)}
    </button>
  );
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [string, string][];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">{label}</span>
      <div
        className="grid grid-cols-2 gap-1 rounded-lg bg-ink/5 p-1"
        role="radiogroup"
        aria-label={label}
      >
        {options.map(([key, text]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === key}
            className={`focus-ring rounded-md px-3 py-2 text-sm transition-colors ${
              value === key
                ? "bg-panel font-medium shadow-sm"
                : "text-ink/60 hover:text-ink"
            }`}
            onClick={() => onChange(key)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-ink/50">{children}</p>;
}
