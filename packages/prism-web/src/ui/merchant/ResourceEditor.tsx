import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AirVent,
  CreditCard,
  DoorOpen,
  Info,
  Plus,
  Power,
  Trash2,
  Ungroup,
  Users,
  X,
  type LucideIcon,
  Bot,
} from "lucide-react";
import { Api, api, type BotSettings, type Resource } from "../../api";
import { useI18n } from "../../i18n";
import { ActionForm, Field, button, buttonQuiet, input, primary, useMerchant, useResource } from "./shared";
import { useBillablePlans, useResourceGroups } from "./ResourceGroups";
import { resourceCapabilities, type CapabilityId } from "./resource-capabilities";
import { RotateTokenConfirm } from "./RotateTokenConfirm";
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
 * Resource configuration, one section at a time: what it is, what it bills and
 * how many it holds, then each capability it has. A capability with something
 * left to fill in is marked in the list, so nothing half-done hides behind a
 * collapsed card.
 */
export function ResourceEditor({
  value,
  groupId: initialGroupId,
  done,
  onLockChange,
}: {
  value?: Resource;
  /** The group a new resource is added to. */
  groupId?: string;
  done: () => void;
  /** Locks the dialog while a one-time token is on screen. */
  onLockChange: (locked: boolean) => void;
}) {
  const { shopId, shopCode, owner } = useMerchant();
  const { t } = useI18n();
  const shopSettings = useResource<{
    settings: { ttLockConnection?: Record<string, string | undefined> | null };
  }>(owner ? "settings" : null);
  const lock = shopSettings.data?.settings.ttLockConnection;
  const ttLockMissing =
    !!shopSettings.data &&
    !(lock?.clientId && lock.clientSecret && (lock.accessToken || lock.appAccount));
  const shopPath = `/merchant/${encodeURIComponent(shopCode)}`;
  const initial = resourceCapabilities(
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
  // One section is shown at a time: the basics, billing and occupancy, an
  // enabled capability, or the list of capabilities still to add.
  const [pane, setPane] = useState<"basic" | "usage" | "add" | CapabilityId>("basic");
  const [name, setName] = useState(value?.name ?? "");
  // One value per alias. The editor always renders one extra empty row, so an
  // empty array is the correct starting point for a device without aliases.
  const [aliases, setAliases] = useState<string[]>(value?.aliases ?? []);
  const [enabled, setEnabled] = useState(value ? !!value.enabled : true);
  // Empty for a new resource: the server picks 1 for a cabinet with an IO, 0 otherwise.
  const [resourceCapacity, setResourceCapacity] = useState(value?.capacity === undefined ? "" : String(value.capacity));
  const [occupancyMinutes, setOccupancyMinutes] = useState(String(value?.occupancyMinutes ?? 15));

  const ha = useHaConnections(shopId);
  const idle = useIdleSettings(shopId);
  const ownIdle = value ? idle.settings?.devices[value.id] : undefined;
  const [idleExclude, setIdleExclude] = useState(false);
  useEffect(() => {
    setIdleExclude(!!ownIdle?.exclude);
  }, [ownIdle?.exclude]);
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

  // A HINATA IO connects straight to the platform unless it already runs through
  // an external relay: direct is what a new card cabinet is set up with.
  const [embedded, setEmbedded] = useState(
    initial.hinata_io ? value?.relayConnection === "embedded" : true,
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
  const [mahjongPricing, setMahjongPricing] = useState<string[]>(
    value?.mahjong?.pricingConfigIds ?? [],
  );
  const [pricing, setPricing] = useState<
    { id: string; name: string; enabled: boolean }[]
  >([]);
  // Which plan scanning this resource starts: its group's, or one of its own.
  const [groupId, setGroupId] = useState(value?.resourceGroupId ?? initialGroupId ?? "default");
  const [overrideId, setOverrideId] = useState(value?.pricingConfigOverrideId ?? "");
  const { groups } = useResourceGroups(shopId);
  const billablePlans = useBillablePlans(shopCode);
  const groupPlanId = groups?.find((group) => group.id === groupId)?.defaultPricingConfigId ?? null;
  const groupPlanName = groupPlanId ? billablePlans.find((plan) => plan.id === groupPlanId)?.name ?? null : null;
  // Without its own plan or its group's, the resource is free to use.
  const billed = !!overrideId || !!groupPlanId;

  const [issued, setIssued] = useState<{ token: string; url: string } | null>(
    null,
  );
  const [live, setLive] = useState<Resource | null>(value ?? null);
  const [bot, setBot] = useState<BotSettings>(() => ({ ...defaultBotSettings, ...(value?.bot ?? {}) }));
  const changeBot = (patch: Partial<BotSettings>) => setBot((current) => ({ ...current, ...patch }));
  // Shown once, after the bot is created or its token replaced.
  const [botToken, setBotToken] = useState<string | null>(null);
  const [doors, setDoors] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!caps.bot) return;
    Api.machines(shopId)
      .then((r) => setDoors(r.machines.filter((m) => m.ttlockLockId).map((m) => ({ id: m.id, name: m.name }))))
      .catch(() => setDoors([]));
  }, [caps.bot, shopId]);
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
    onLockChange(!!issued || !!botToken);
    return () => onLockChange(false);
  }, [issued, botToken, onLockChange]);

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
    if (id === "mahjong" && billed && !mahjongPricing.length) return t("请选择一条麻将计费规则");
    return null;
  };

  /** Adding a capability shows it, because that is when it has to be filled in. */
  const enable = (id: CapabilityId) => {
    if (id === "climate" && ac.connection === NEW_CONNECTION && !ac.url.trim())
      // Usually the same Home Assistant as the power switch.
      setAc({ ...ac, connection: power.connection, url: power.url });
    setCaps((current) => ({ ...current, [id]: true }));
    setPane(id);
  };
  const remove = (id: CapabilityId) => {
    setCaps((current) => ({ ...current, [id]: false }));
    setPane("basic");
  };

  /** Why an enabled capability still cannot be saved, if it cannot. */
  const incomplete = (id: CapabilityId): string | null =>
    caps[id] ? missingConfig(id) : null;

  const seatsFrom = capabilityList.find((id) => caps[id] && capabilityMeta[id].seats) ?? null;
  const sections: { id: typeof pane; label: string; icon: LucideIcon; problem?: boolean }[] = [
    { id: "basic", label: "基本信息", icon: Info },
    { id: "usage", label: "计费与占用", icon: Users },
    ...capabilityList.filter((id) => caps[id]).map((id) => ({
      id, label: capabilityMeta[id].label, icon: capabilityMeta[id].icon, problem: !!incomplete(id),
    })),
    ...(capabilityList.some((id) => !caps[id]) ? [{ id: "add" as const, label: "添加能力", icon: Plus }] : []),
  ];

  /** The INI fragment a machine needs to reach this platform directly. */
  const iniSnippet = issued
    ? `serverUrl=${issued.url}\ndeviceToken=${issued.token}`
    : "";

  if (botToken) {
    const snippet = `baseUrl: ${window.location.origin}\nintegrationToken: ${botToken}`;
    return (
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h3 className="text-sm font-semibold">{t("Bot 令牌已签发")}</h3>
          <p className="text-xs leading-relaxed text-ink/60">
            {t("这是唯一一次显示，离开后无法再次查看。")}
          </p>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t("填入 Koishi 的 PRiSM 插件")}</span>
            <CopyButton value={snippet} label="复制配置" />
          </div>
          <pre className="overflow-x-auto whitespace-pre rounded-lg bg-ink/5 p-3 text-xs">{snippet}</pre>
          <p className="text-xs leading-relaxed text-ink/60">
            {t("插件只需要这两项：接入凭据自己知道是哪个店铺。其余设置都在这里修改，保存后会自动推送给 Bot。")}
          </p>
        </div>
        <button
          type="button"
          className={`${primary} justify-self-start`}
          onClick={() => {
            setBotToken(null);
            done();
          }}
        >
          {t("我已填入插件")}
        </button>
      </div>
    );
  }

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
          machine?: Resource;
          relayToken?: string;
          botToken?: string;
        } | null;
        if (saved?.machine) setLive(saved.machine);
        if (saved?.botToken) {
          setBotToken(saved.botToken);
          return true;
        }
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
        if (!name.trim()) throw new Error(t("请填写资源名称"));
        for (const id of capabilityList) {
          const reason = incomplete(id);
          if (reason) {
            // Show the capability so the message lands next to its fields.
            setPane(id);
            throw new Error(reason);
          }
        }
        const seats = resourceCapacity.trim() === "" ? null : Number(resourceCapacity);
        if (caps.mahjong && seats !== null && (!Number.isInteger(seats) || seats < 2 || seats > 8)) {
          setPane("usage");
          throw new Error(t("麻将桌容量须为 2 到 8 人"));
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
          setPane("hinata_io");
          throw new Error(t("请先签发设备令牌，或改为外部中继。"));
        }
        const saved = await api<{ machine: Resource }>(`/api/v1/merchant/machines${value ? `/${value.id}` : ""}`, {
          method: value ? "PATCH" : "POST",
          body: JSON.stringify({
            shopId,
            name: name.trim(),
            aliases: aliases
              .map((alias) => alias.trim())
              .filter(Boolean),
            kind: caps.door ? "door" : "machine",
            enabled,
            ...(resourceCapacity.trim() !== "" ? { capacity: Number(resourceCapacity) } : {}),
            occupancyMinutes: Number(occupancyMinutes) || 15,
            bot: caps.bot ? bot : null,
            ...(caps.bot && f.get("intent") === "rotate-bot" ? { rotateBotToken: true } : {}),
            resourceGroupId: groupId,
            pricingConfigOverrideId: overrideId || null,
            mahjong: caps.mahjong ? { pricingConfigIds: mahjongPricing } : null,
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
        // Whether it is never switched off lives with the shop's idle rules, keyed by device.
        const own = idle.settings?.devices[saved.machine.id];
        if (caps.power && !!own?.exclude !== idleExclude) {
          await api(idlePath(shopId, `/devices/${encodeURIComponent(saved.machine.id)}`), {
            method: "PUT",
            body: JSON.stringify({ exclude: idleExclude }),
          });
        }
        return saved;
      }}
    >
      <div className="grid gap-5 sm:min-h-[26rem] sm:grid-cols-[11rem_minmax(0,1fr)]">
        <nav aria-label={t("资源设置")} className="flex gap-1 overflow-x-auto pb-1 sm:flex-col sm:self-start">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              aria-current={pane === section.id ? "page" : undefined}
              className={`focus-ring flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm ${pane === section.id ? "bg-mint/10 font-semibold text-ink" : "text-ink/60 hover:bg-ink/5 hover:text-ink"}`}
              onClick={() => setPane(section.id)}
            >
              <section.icon size={16} aria-hidden="true" />
              <span className="truncate">{t(section.label)}</span>
              {section.problem && <span className="ml-auto size-2 shrink-0 rounded-full bg-coral" aria-label={t("待配置")} />}
            </button>
          ))}
        </nav>
        <div className="grid min-w-0 content-start gap-4">
      {pane === "basic" && (
        <>
        <Field label="资源名称">
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
            <span className="text-sm font-medium">{t("资源别名")}</span>
            <p className="mt-1 text-xs text-ink/50">
              {t("玩家和 Bot 可以用任意一个别名找到这个资源。")}
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
                  aria-label={`${t("资源别名")} ${index + 1}`}
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
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("启用")}
        </label>
        </>
      )}
      {pane === "usage" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
              <Field label="所属资源组">
                <select className={input} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  {(groups ?? [{ id: "default", name: "默认资源组" }]).map((group) => (
                    <option key={group.id} value={group.id}>{t(group.name)}</option>
                  ))}
                </select>
              </Field>
              <Field label="计费方案覆盖">
                <select className={input} value={overrideId} onChange={(e) => setOverrideId(e.target.value)}>
                  <option value="">
                    {groupPlanName ? t("跟随资源组（{plan}）", { plan: groupPlanName }) : t("跟随资源组（不计费）")}
                  </option>
                  {billablePlans.map((plan) => (
                    <option key={plan.id} value={plan.id}>{plan.name}</option>
                  ))}
                </select>
              </Field>
            </div>
          {!caps.bot && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="容量" unit="人">
                <input
                  className={input}
                  type="number"
                  min={caps.mahjong ? 2 : 0}
                  max={caps.mahjong ? 8 : 16}
                  placeholder={t("按能力自动")}
                  value={resourceCapacity}
                  onChange={(e) => setResourceCapacity(e.target.value)}
                />
              </Field>
              {seatsFrom ? (
                <div className="grid gap-2">
                  <span className="text-sm font-medium">{t("占用时长")}</span>
                  <p className="rounded-lg bg-ink/[0.04] px-3 py-2.5 text-sm text-ink/60">{t("不适用")}</p>
                </div>
              ) : (
                <Field label="占用时长" unit="分钟">
                  <input
                    className={input}
                    type="number"
                    min="1"
                    max="1440"
                    required
                    value={occupancyMinutes}
                    onChange={(e) => setOccupancyMinutes(e.target.value)}
                  />
                </Field>
              )}
            </div>
          )}
          {!caps.bot && seatsFrom && (
            <Hint>{t("{capability}按座位判断占用：入座开始，下桌结束；占用时长不适用。", { capability: t(capabilityMeta[seatsFrom].label) })}</Hint>
          )}
        </>
      )}
      {pane === "power" && caps.power && (
        <CapabilityPane title="电源控制" problem={incomplete("power")} remove={() => remove("power")}>
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
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={idleExclude} onChange={(e) => setIdleExclude(e.target.checked)} />
            {t("从不自动关机")}
          </label>
        </CapabilityPane>
      )}
      {pane === "climate" && caps.climate && (
        <CapabilityPane title="空调" problem={incomplete("climate")} remove={() => remove("climate")}>
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
        </CapabilityPane>
      )}
      {pane === "hinata_io" && caps.hinata_io && (
        <CapabilityPane title="刷卡 · HINATA IO" problem={incomplete("hinata_io")} remove={() => remove("hinata_io")}>
          <div className="grid gap-4">
            <Segmented
              label={t("连接方式")}
              options={[
                ["embedded", t("直连本平台")],
                ["external", t("外部中继")],
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
        </CapabilityPane>
      )}
      {pane === "door" && caps.door && (
        <CapabilityPane title="开门密码" problem={incomplete("door")} remove={() => remove("door")}>
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
        </CapabilityPane>
      )}
      {pane === "mahjong" && caps.mahjong && (
        <CapabilityPane title="麻将桌" problem={incomplete("mahjong")} remove={() => remove("mahjong")}>
          <div className="grid gap-3">
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">
                {t("对局方案")}
              </legend>
              {pricing.filter((r) => r.enabled).length === 0 ? (
                <p className="text-sm text-ink/55">
                  {t("还没有启用中的计费规则。")}{" "}
                  <Link className="underline" to={`${shopPath}/pricing`}>
                    {t("去「计费」页创建")}
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
                          type="radio"
                          name="mahjong-pricing"
                          checked={mahjongPricing[0] === r.id}
                          onChange={() => setMahjongPricing([r.id])}
                        />
                        {r.name}
                      </label>
                    ))}
                </div>
              )}
            </fieldset>
          </div>
        </CapabilityPane>
      )}
      {pane === "bot" && caps.bot && (
        <CapabilityPane title="店铺 Bot" problem={incomplete("bot")} remove={() => remove("bot")}>
          <div className="grid gap-4">
            <BotTokenPanel live={live} hasBotToken={!!live?.hasBotToken} />
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">{t("玩家命令")}</legend>
              {(["all", "readonly"] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="bot-player-commands"
                    checked={bot.playerCommands === mode}
                    onChange={() => changeBot({ playerCommands: mode })}
                  />
                  {t(mode === "all" ? "全部命令" : "只读")}
                </label>
              ))}
              <p className="text-xs text-ink/55">{t("只读时，玩家在 Bot 里只能绑定身份、查余额和账单、兑换。")}</p>
              {bot.playerCommands === "readonly" && (
                <Field label="只读提示">
                  <input
                    className={input}
                    maxLength={200}
                    value={bot.readOnlyNotice}
                    onChange={(e) => changeBot({ readOnlyNotice: e.target.value })}
                  />
                </Field>
              )}
            </fieldset>
            <div className="grid gap-2">
              {([
                ["staffCommands", "店员代为操作"],
                ["powerOffStaffOnly", "仅店员可关机"],
                ["receiptsToStaff", "结账回执发给店员"],
                ["doorPasswordOnEntry", "入场后自动获取门锁密码"],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={bot[key]} onChange={(e) => changeBot({ [key]: e.target.checked })} />
                  {t(label)}
                </label>
              ))}
            </div>
            <Field label="默认门锁">
              <select
                className={input}
                value={bot.doorResourceId ?? ""}
                onChange={(e) => changeBot({ doorResourceId: e.target.value || null })}
              >
                <option value="">{t(doors.length === 1 ? "自动" : "未设置")}</option>
                {doors.map((door) => (
                  <option key={door.id} value={door.id}>{door.name}</option>
                ))}
              </select>
            </Field>
            {bot.doorPasswordOnEntry && (
              <p className="text-xs text-ink/55">
                {t("玩家用 login／入场 进来时，Bot 会顺带生成一个门锁临时密码并回复；不下场也会在 3 分钟后失效。没有门锁时不生效。")}
              </p>
            )}
            <fieldset className="grid gap-3">
              <legend className="mb-1 text-sm font-medium">{t("播报与提醒")}</legend>
              <div className="grid gap-1">
                <Field label="播报群">
                  <textarea
                    className={`${input} min-h-20`}
                    value={bot.announceChannelIds.join("\n")}
                    onChange={(e) => changeBot({ announceChannelIds: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })}
                  />
                </Field>
                <p className="text-xs text-ink/55">{t("每行一个群号。闲置提醒和店内动态都发到这里。")}</p>
              </div>
              <Field label="提醒提前量" unit="分钟">
                <input
                  className={input}
                  type="number"
                  min="0"
                  max="120"
                  value={bot.idleReminderMinutes}
                  onChange={(e) => changeBot({ idleReminderMinutes: Number(e.target.value) || 0 })}
                />
              </Field>
              <div className="grid gap-2">
                <span className="text-sm">{t("播报这些")}</span>
                {(
                  [
                    ["announceIdle", "设备闲置（关机前提醒）"],
                    ["announcePower", "开机、关机（含闲置自动关机）"],
                    ["announceStarts", "上机（刷卡或投币后开始占用机台）"],
                    ["announceCards", "刷卡"],
                    ["announceCoins", "投币"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={bot[key]} onChange={(e) => changeBot({ [key]: e.target.checked })} />
                    {t(label)}
                  </label>
                ))}
              </div>
              <p className="text-xs text-ink/55">
                {t("刷卡或投币同时上机时只发一条：开了「上机」就按上机播报，否则按刷卡或投币播报。提前量为 0 时不做闲置提醒。通过这个 Bot 自己的命令做的操作不会再播报一遍。")}
              </p>
            </fieldset>
          </div>
        </CapabilityPane>
      )}
      {pane === "add" && (
        <ul className="grid gap-2">
          {capabilityList.filter((id) => !caps[id]).map((id) => {
            const item = capabilityMeta[id];
            return (
              <li key={id} className="flex items-center gap-3 rounded-xl border border-ink/10 p-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink/5 text-ink/50">
                  <item.icon size={18} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t(item.label)}</span>
                  <span className="block text-xs text-ink/55">{t(item.description)}</span>
                </span>
                <button type="button" className={`${button} min-h-9 px-3 py-1 text-xs`} onClick={() => enable(id)}>
                  <Plus size={14} aria-hidden="true" />
                  {t("添加")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
        </div>
      </div>
    </ActionForm>
  );
}

const defaultBotSettings: BotSettings = {
  playerCommands: "all",
  readOnlyNotice: "请扫描店内二维码或碰 NFC，在网页或 App Clip 里入场、结账和操作设备。",
  staffCommands: true,
  powerOffStaffOnly: false,
  doorResourceId: null,
  receiptsToStaff: false,
  doorPasswordOnEntry: false,
  announceChannelIds: [],
  idleReminderMinutes: 5,
  announceIdle: false,
  announcePower: false,
  announceStarts: false,
  announceCards: false,
  announceCoins: false,
};

const capabilityList = ["power", "climate", "hinata_io", "door", "mahjong", "bot"] as const satisfies readonly CapabilityId[];

/** `seats`: the capability holds its occupants itself, so the occupancy time does not apply. */
const capabilityMeta: Record<CapabilityId, { icon: LucideIcon; label: string; description: string; seats?: true }> = {
  power: { icon: Power, label: "电源控制", description: "通过 Home Assistant 读取并开关电源。" },
  climate: { icon: AirVent, label: "空调", description: "通过 Home Assistant 控制空调。" },
  hinata_io: { icon: CreditCard, label: "刷卡 · HINATA IO", description: "刷卡、投币，记录谁在玩。" },
  door: { icon: DoorOpen, label: "开门密码", description: "通过 TTLock 生成一次性开门密码。" },
  mahjong: { icon: Ungroup, label: "麻将桌", description: "按座位开桌计费。", seats: true },
  bot: { icon: Bot, label: "店铺 Bot", description: "Koishi 等聊天机器人。" },
};

/** One enabled capability: its settings, why it cannot be saved yet, and removing it. */
function CapabilityPane({
  title,
  problem,
  remove,
  children,
}: {
  title: string;
  problem: string | null;
  remove: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="grid gap-4" aria-label={t(title)}>
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t(title)}</h3>
        <button type="button" className={`${buttonQuiet} min-h-9 px-2 text-xs text-coral`} onClick={remove}>
          <Trash2 size={14} aria-hidden="true" />
          {t("移除")}
        </button>
      </header>
      {problem && <p role="alert" className="text-sm text-coral">{problem}</p>}
      {children}
    </section>
  );
}

/** A value the shop pastes elsewhere, with a copy button. */
function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  return (
    <div className="grid min-w-0 gap-1">
      <span className="flex items-center justify-between gap-2 text-xs font-medium text-ink/60">
        {t(label)}
        <CopyButton value={value} label="复制" />
      </span>
      <code className="truncate rounded bg-ink/5 px-2 py-1.5 text-xs">{value}</code>
    </div>
  );
}

/**
 * The bot's credential, presented and minted the way a device's direct-connect
 * token is: one line saying whether it has one, and one button that issues or
 * rotates it. Minting is an explicit submit (`intent=rotate-bot`), never a side
 * effect of saving the settings.
 */
function BotTokenPanel({
  live,
  hasBotToken,
}: {
  live: Resource | null;
  hasBotToken: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3 rounded-lg border border-ink/10 bg-ink/[0.02] p-3">
      <p className="text-sm">
        <span className="text-ink/60">{t("接入凭据")}：</span>
        {hasBotToken ? (
          <span className="text-mint">{t("已签发")}</span>
        ) : (
          <span className="text-ink/50">{t("未签发")}</span>
        )}
      </p>
      <p className="text-xs leading-relaxed text-ink/60">
        {t("凭据自己指明店铺，Koishi 里只需要接口地址和凭据。")}
      </p>
      {hasBotToken ? (
        <RotateTokenConfirm
          label="轮换 Bot 凭据"
          warn="轮换后旧凭据立即失效，正在用它的 Koishi 会断线，需要把新凭据重新填进去才能连上。"
        >
          <button type="submit" name="intent" value="rotate-bot" className={`${primary} justify-self-start`}>
            {t("确认轮换 Bot 凭据")}
          </button>
        </RotateTokenConfirm>
      ) : (
        <button type="submit" name="intent" value="rotate-bot" className={`${button} justify-self-start`}>
          {t("签发 Bot 凭据")}
        </button>
      )}
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
  live: Resource | null;
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
      {hasRelayToken ? (
        <RotateTokenConfirm
          label="轮换设备令牌"
          warn="轮换后机台上的旧令牌立即失效，机台会掉线，需要把新令牌重新写进 INI 并重启才能连上。"
        >
          <button type="submit" name="intent" value="issue" className={`${primary} justify-self-start`}>
            {t("确认轮换设备令牌")}
          </button>
        </RotateTokenConfirm>
      ) : (
        <button type="submit" name="intent" value="issue" className={`${button} justify-self-start`}>
          {t("签发设备令牌")}
        </button>
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
