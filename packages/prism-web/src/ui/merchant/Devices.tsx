import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  DoorOpen,
  Gamepad2,
  Plus,
  QrCode,
  Pencil,
  Power,
  CreditCard,
} from "lucide-react";
import { Api, api, playerOperation, type DeviceEvent, type Machine } from "../../api";
import { useI18n } from "../../i18n";
import {
  ActionForm,
  date,
  Field,
  Modal,
  State,
  button,
  primary,
  input,
  useMerchant,
} from "./shared";

export function DevicesPage() {
  const { shopId, canWrite } = useMerchant();
  const { t } = useI18n();
  const [devices, setDevices] = useState<Machine[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Machine | "new" | null>(null);
  const [qr, setQR] = useState<Machine | null>(null);
  const [filter, setFilter] = useState("all");
  const [operating, setOperating] = useState<Machine | null>(null);
  const load = useCallback(
    () => Api.machines(shopId).then((r) => setDevices(r.machines)),
    [shopId],
  );
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  const shown = devices?.filter((d) =>
    filter === "all"
      ? true
      : filter === "door"
        ? !!d.ttlockLockId
        : filter === "machine"
          ? !!(d.homeAssistant || d.hasHinata || d.mahjong)
          : !d.ttlockLockId && !d.homeAssistant && !d.hasHinata && !d.mahjong,
  );
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t("店内设备")}</h2>
        </div>
        {canWrite && (
          <button className={primary} onClick={() => setEditing("new")}>
            <Plus size={17} />
            {t("添加设备")}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2" aria-label={t("设备类型")}>
        {[
          ["all", "全部"],
          ["door", "门锁"],
          ["machine", "机台"],
          ["empty", "未绑定"],
        ].map(([key, label]) => (
          <button
            className={`${button} min-h-9 rounded-full px-4 py-1 ${filter === key ? "bg-ink/5 font-semibold" : "border-transparent text-ink/55"}`}
            key={key}
            aria-pressed={filter === key}
            onClick={() => setFilter(key!)}
          >
            {t(label!)}
            {key === "all" && devices && (
              <span className="text-xs text-ink/40">{devices.length}</span>
            )}
          </button>
        ))}
      </div>
      {!shown ? (
        <State error={error} />
      ) : !shown.length ? (
        <div className="rounded-lg border border-dashed border-ink/20 py-16 text-center">
          <Gamepad2 className="mx-auto mb-4 text-ink/30" size={32} />
          <p className="font-medium">{t("暂无设备")}</p>
          <p className="mt-2 text-sm text-ink/55">
            {t("先添加门锁或机台，再将设备二维码放在对应位置。")}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((device) => (
            <article
              key={device.id}
              className={`flex flex-col rounded-xl border border-ink/10 bg-panel ${!device.enabled ? "opacity-60" : ""}`}
            >
              <div className="flex items-start gap-3 p-5">
                <span
                  className={`grid size-11 shrink-0 place-items-center rounded-lg ${!!device.ttlockLockId ? "bg-amber-100 text-amber-800" : "bg-mint/10 text-mint"}`}
                >
                  {!!device.ttlockLockId ? (
                    <DoorOpen size={22} />
                  ) : (
                    <Gamepad2 size={22} />
                  )}
                </span>
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{device.name}</h3>
                  <p className="mt-1 text-xs text-ink/50">
                    {t(
                      device.ttlockLockId
                        ? "获取开门密码"
                        : device.homeAssistant || device.hasHinata || device.mahjong
                          ? "机台操作"
                          : "未绑定能力",
                    )}
                    {!device.enabled && ` · ${t("已停用")}`}
                  </p>
                </div>
              </div>
              <div className="mb-5 flex flex-wrap gap-2 px-5 text-xs text-ink/70">
                {device.mahjong && <span className="rounded bg-ink/5 px-2 py-1">{t("麻将桌")}</span>}
                {device.homeAssistant && (
                  <span className="flex items-center gap-1.5 rounded bg-ink/5 px-2 py-1">
                    <Power size={13} />
                    {t("电源")}
                  </span>
                )}
                {device.hasHinata && (
                  <span className="flex items-center gap-1.5 rounded bg-ink/5 px-2 py-1">
                    <CreditCard size={13} />
                    {t(
                      device.coinAfterSwipe
                        ? "刷卡 · 自动投币"
                        : device.hasPassword && device.coinEnabled
                          ? "投币 / 刷卡"
                          : "刷卡",
                    )}
                  </span>
                )}
                {device.relayConnection === "embedded" && (
                  <span className="flex items-center gap-1.5 rounded bg-ink/5 px-2 py-1">
                    <CreditCard size={13} />
                    {t("刷卡 · 直连")}
                    {/* Only the direct mode has a live connection to report; the
                        external relay cannot be observed from here. */}
                    <span
                      className={
                        device.relayOnline === true
                          ? "text-mint"
                          : device.relayOnline === false
                            ? "text-coral"
                            : "text-ink/40"
                      }
                      title={
                        device.relayOnline === true
                          ? t("已连接")
                          : device.relayOnline === false
                            ? t("未连接")
                            : t("未知")
                      }
                    >
                      ●
                    </span>
                  </span>
                )}
                {!!device.ttlockLockId && (
                  <span className="rounded bg-ink/5 px-2 py-1">
                    TTLock · {device.ttlockLockId}
                  </span>
                )}
              </div>
              {device.homeAssistant && <PowerStatus device={device} />}
              <footer className="mt-auto flex items-center justify-between border-t border-ink/10 px-4 py-2">
                <button
                  className={`${button} border-transparent px-2`}
                  onClick={() => setQR(device)}
                >
                  <QrCode size={16} />
                  {t("设备二维码")}
                </button>
                <button
                  className={`${button} border-transparent px-2`}
                  onClick={() => setOperating(device)}
                >
                  {t("操作记录")}
                </button>
                {canWrite && (
                  <button
                    className={`${button} border-transparent px-2`}
                    aria-label={`${t("编辑")} ${device.name}`}
                    onClick={() => setEditing(device)}
                  >
                    <Pencil size={16} />
                    {t("编辑")}
                  </button>
                )}
              </footer>
            </article>
          ))}
        </div>
      )}
      {operating && (
        <Modal title={operating.name} close={() => setOperating(null)}>
          <DeviceOperations device={operating} />
        </Modal>
      )}
      {editing && (
        <Modal
          title={editing === "new" ? "添加设备" : "编辑设备"}
          close={() => setEditing(null)}
        >
          <DeviceEditor
            value={editing === "new" ? undefined : editing}
            done={() => {
              setEditing(null);
              void load();
            }}
          />
        </Modal>
      )}
      {qr && (
        <Modal title="设备二维码" close={() => setQR(null)}>
          <div className="grid justify-items-center gap-5">
            <div className="bg-white p-4">
              <QRCodeSVG
                value={`${window.location.origin}/t/${qr.shopPublicId}/${qr.publicId}`}
                size={224}
                level="M"
              />
            </div>
            <h3 className="text-lg font-semibold">{qr.name}</h3>
            <p className="text-sm text-ink/60">
              {t("扫码打开设备")}
            </p>
            <a
              className={button}
              href={`/t/${qr.shopPublicId}/${qr.publicId}`}
              target="_blank"
              rel="noreferrer"
            >
              {t("测试扫码入口")}
            </a>
            <button
              className={button}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    `${window.location.origin}/t/${qr.shopPublicId}/${qr.publicId}`,
                  );
                } catch {
                  setError(t("复制失败"));
                }
              }}
            >
              {t("复制链接 / 写入 NFC")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function DeviceEditor({ value, done }: { value?: Machine; done: () => void }) {
  const { shopId } = useMerchant();
  const { t } = useI18n();
  const [mahjong, setMahjong] = useState(!!value?.mahjong);
  const [pricing, setPricing] = useState<{id:string;name:string;enabled:boolean}[]>([]);
  const [mahjongPricing, setMahjongPricing] = useState(value?.mahjong?.pricingConfigIds ?? []);
  const { shopCode, billingEnabled } = useMerchant();
  useEffect(() => {
    if (mahjong) api<{pricingConfigs:typeof pricing}>(`/api/v1/shops/${encodeURIComponent(shopCode)}/staff/pricing-configs`)
      .then(r=>setPricing(r.pricingConfigs)).catch(()=>setPricing([]));
  }, [mahjong, shopCode]);
  const [hasLock, setLock] = useState(!!value?.ttlockLockId);
  const [hasHA, setHA] = useState(!!value?.homeAssistant);
  const [hasIO, setIO] = useState(!!value?.hasHinata || value?.relayConnection === "embedded");
  const [coinKey, setCoinKey] = useState(value?.coinKey ? String(value.coinKey) : "");
  const [passwordEntered, setPasswordEntered] = useState(!!value?.hasPassword);
  // Direct connection: the machine talks to this platform instead of an external
  // relay, so it needs no E2EE password and gets a device token of its own.
  const [embedded, setEmbedded] = useState(value?.relayConnection === "embedded");
  const [issued, setIssued] = useState<{ token: string; url: string } | null>(null);
  // `value` is the row as it was when the editor opened. After a save the row
  // has changed, so the connection status and e2ee warning would otherwise keep
  // showing pre-save facts until the modal is reopened.
  const [live, setLive] = useState<Machine | null>(value ?? null);
  const canCoin = embedded || passwordEntered;

  return (
    <ActionForm
      done={done}
      onResult={(result) => {
        // The device token is returned exactly once. Keep the editor open so the
        // store can copy it, and never re-fetch it: it is not recoverable.
        const saved = (result as { machine?: Machine; relayToken?: string } | null);
        if (saved?.machine) setLive(saved.machine);
        const token = saved?.relayToken;
        if (!token) {
          // A save that issued no token means the previous one is still in use;
          // showing the old value would suggest it had just been re-issued.
          setIssued(null);
          return false;
        }
        setIssued({
          token,
          url: saved?.machine?.relayUrl ?? "",
        });
        return true;
      }}
      submit={(f) =>
        api(`/api/v1/merchant/machines${value ? `/${value.id}` : ""}`, {
          method: value ? "PATCH" : "POST",
          body: JSON.stringify({
            shopId,
            name: f.get("name"),
            aliases: String(f.get("aliases") ?? "").split(",").map((alias) => alias.trim()).filter(Boolean),
            kind: hasLock ? "door" : "machine",
            mahjong: mahjong ? {capacity:Number(f.get("capacity")),pricingConfigIds:mahjongPricing} : null,
            enabled: f.get("enabled") === "on",
            // Unticking HINATA IO removes it whichever transport it used.
            relayConnection: hasIO && embedded ? "embedded" : "external",
            ...(hasIO && embedded && f.get("rotateRelayToken") === "on" ? { rotateRelayToken: true } : {}),
            // Direct mode is authenticated by its device token, so it has no URL
            // or password to send, and the platform rejects the combination.
            hinataUrl: embedded || !hasIO ? null : f.get("hinataUrl"),
            // A blank password field keeps the stored one.
            ...(hasIO && !embedded && f.get("password") ? { hinataPassword: f.get("password") } : {}),
            homeAssistant:
              hasHA
                ? {
                    url: f.get("haUrl"),
                    entityId: f.get("entityId"),
                    ...(f.get("haToken") ? { token: f.get("haToken") } : {}),
                  }
                : null,
            coinKey: hasIO && canCoin ? Number(coinKey || 0) : 0,
            coinAfterSwipe: hasIO && canCoin && Number(coinKey) > 0 && f.get("coinAfterSwipe") === "on",
            ttlockLockId: hasLock ? Number(f.get("lockId")) : null,
          }),
        })
      }
    >
      <Field label="设备名称">
        <input
          autoFocus
          className={input}
          name="name"
          required
          maxLength={80}
          defaultValue={value?.name}
        />
      </Field>
      <Field label="设备别名">
        <input
          className={input}
          name="aliases"
          placeholder="用逗号分隔，例如 mai、舞萌"
          defaultValue={value?.aliases?.join(", ")}
        />
      </Field>
      <fieldset className="grid gap-3">
        <legend className="mb-3 text-sm font-medium">{t("设备能力")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={mahjong} onChange={e=>setMahjong(e.target.checked)} />
          {t("麻将桌")}
        </label>
        {mahjong && <div className="grid gap-3 border-l-2 border-mint/25 pl-4">
          <Field label="开桌人数"><input className={input} type="number" name="capacity" min="2" max="8" required defaultValue={value?.mahjong?.capacity ?? 4} /></Field>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm">{t("麻将计费规则")}</legend>
            {pricing.filter(r=>r.enabled).map(r=><label className="flex items-center gap-2 text-sm" key={r.id}>
              <input type="checkbox" checked={mahjongPricing.includes(r.id)} onChange={e=>setMahjongPricing(e.target.checked ? [...mahjongPricing,r.id] : mahjongPricing.filter(id=>id!==r.id))} />{r.name}
            </label>)}
            {billingEnabled && !mahjongPricing.length && <p className="text-sm text-ink/60">{t("请选择麻将计费规则")}</p>}
          </fieldset>
        </div>}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hasHA}
            onChange={(e) => setHA(e.target.checked)}
          />
          {t("电源控制 · Home Assistant")}
        </label>
        {hasHA && (
          <div className="grid gap-3 border-l-2 border-mint/25 pl-4">
            <Field label="Home Assistant 地址">
              <input
                className={input}
                type="url"
                required
                name="haUrl"
                placeholder="https://ha.example.com"
                defaultValue={value?.homeAssistant?.url}
              />
            </Field>
            <Field label="电源实体">
              <input
                className={input}
                required
                name="entityId"
                placeholder="switch.maimai"
                defaultValue={value?.homeAssistant?.entityId}
              />
            </Field>
            <Field label="长期访问令牌">
              <input
                className={input}
                type="password"
                required={!value?.homeAssistant}
                name="haToken"
                autoComplete="new-password"
                placeholder={value?.homeAssistant ? t("留空保持不变") : ""}
              />
            </Field>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hasIO}
            onChange={(e) => setIO(e.target.checked)}
          />
          {t("刷卡 · HINATA IO")}
        </label>
        {hasIO && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={embedded}
              onChange={(e) => setEmbedded(e.target.checked)}
            />
            {t("机台直连本平台（无需外部中继）")}
          </label>
        )}
        {hasIO && embedded && (
          <div className="grid gap-3 border-l-2 border-mint/25 pl-4">
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
            {issued ? (
              <div className="grid gap-2 rounded border border-mint/30 p-3">
                <p className="text-sm font-medium">{t("设备令牌（仅显示一次）")}</p>
                <code className="break-all rounded bg-ink/5 p-2 text-xs">{issued.token}</code>
                <p className="text-xs text-ink/70">
                  {t("把下面两行写入机台的 hinata.ini 或 segatools.ini 的 [aimeio] 段，然后重启机台：")}
                </p>
                <code className="break-all rounded bg-ink/5 p-2 text-xs">
                  {`serverUrl=${issued.url}\ndeviceToken=${issued.token}`}
                </code>
                <p className="text-xs text-coral">{t("离开本页后无法再次查看，请立即保存。")}</p>
              </div>
            ) : (
              <>
                {/* The URL is the same for every machine today, but the store
                    still needs it before the first save. */}
                <p className="break-all text-xs text-ink/60">{`serverUrl=${live?.relayUrl ?? ""}`}</p>
                <p className="text-sm text-ink/70">
                  {live?.hasRelayToken
                    ? t("保存后如未更换令牌，可继续使用原有令牌；勾选轮换令牌可重新签发。")
                    : t("保存后签发设备令牌并显示一次。")}
                </p>
              </>
            )}
            {live?.hasRelayToken && !issued && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="rotateRelayToken" />
                {t("轮换设备令牌")}
              </label>
            )}
            {live?.relayE2ee === true && (
              <p className="text-sm text-coral">
                {t("该机台仍在发送加密消息：请把机台 INI 里的 remotePassword 清空后重启，否则平台无法下发指令。")}
              </p>
            )}
          </div>
        )}
        {hasIO && !embedded && (
          <div className="grid gap-3 border-l-2 border-mint/25 pl-4">
            <Field label="HINATA IO 地址">
              <input
                className={input}
                required
                name="hinataUrl"
                placeholder="https://io.example.com"
                defaultValue={value?.hinataUrl ?? ""}
              />
            </Field>
            <Field label="连接密码">
              <input className={input} type="password" autoComplete="new-password" name="password" placeholder={value?.hasPassword ? t("留空保持不变") : ""} onChange={(e) => setPasswordEntered(e.target.value.length > 0 || !!value?.hasPassword)} />
            </Field>
          </div>
        )}
        {hasIO && (
          <div className="grid gap-3 border-l-2 border-mint/25 pl-4">
            <Field label="投币按键码">
              <input
                className={input}
                type="number"
                name="coinKey"
                min="1"
                max="65535"
                placeholder={t("留空关闭投币")}
                disabled={!canCoin}
                value={coinKey}
                onChange={(e) => setCoinKey(e.target.value)}
              />
              <a className="text-xs text-mint underline" href="https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes" target="_blank" rel="noreferrer">
                Microsoft Virtual-Key Codes
              </a>
            </Field>
            <label className="flex items-center gap-2 py-2 text-sm">
              <input
                type="checkbox"
                name="coinAfterSwipe"
                disabled={!canCoin || !coinKey}
                defaultChecked={value?.coinAfterSwipe ?? false}
              />
              {t("刷卡后自动投一币")}
            </label>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hasLock}
            onChange={(e) => setLock(e.target.checked)}
          />
          {t("开门密码 · TTLock")}
        </label>
        {hasLock && (
          <div className="grid gap-3 border-l-2 border-mint/25 pl-4">
            <Field label="TTLock 门锁 ID">
              <input
                className={input}
                type="number"
                min="1"
                step="1"
                name="lockId"
                required
                defaultValue={value?.ttlockLockId ?? undefined}
              />
            </Field>
            <p className="text-xs text-ink/55">
              {t("TTLock 账号在店铺设置中连接。")}
            </p>
          </div>
        )}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={value ? !!value.enabled : true}
        />
        {t("启用设备")}
      </label>
    </ActionForm>
  );
}

function PowerStatus({ device }: { device: Machine }) {
  const { t } = useI18n();
  const [power, setPower] = useState("loading");
  useEffect(() => {
    let current = true;
    api<{ power: string }>(`/api/v1/merchant/machines/${device.id}/state`)
      .then((r) => {
        if (current) setPower(r.power);
      })
      .catch(() => {
        if (current) setPower("unknown");
      });
    return () => {
      current = false;
    };
  }, [device]);
  return (
    <p
      className={`mb-4 flex items-center gap-2 px-5 text-xs ${power === "on" ? "text-mint" : "text-ink/50"}`}
    >
      <span
        className={`size-1.5 rounded-full ${power === "on" ? "bg-mint" : "bg-ink/30"}`}
      />
      {t(
        power === "on"
          ? "已开机"
          : power === "off"
            ? "已关机"
            : power === "loading"
              ? "读取电源状态…"
              : "电源状态未知",
      )}
    </p>
  );
}
/**
 * Pair each request with its result so an action is one line. A result whose
 * request fell outside the loaded page is shown on its own.
 */
function timeline(events: DeviceEvent[]) {
  const results = new Map(
    events.filter((e) => e.kind === "result" && e.operationId).map((e) => [e.operationId!, e]),
  );
  const requested = new Set(events.filter((e) => e.kind === "request").map((e) => e.operationId));
  return events
    .filter((e) => e.kind !== "result" || !requested.has(e.operationId))
    .map((event) => ({
      event: event.kind === "result" ? { ...event, kind: "request" as const } : event,
      result: event.kind === "result" ? event : event.operationId ? results.get(event.operationId) : undefined,
    }));
}

function changeLabel(event: DeviceEvent): string {
  const to = event.payload.to;
  if (event.name === "power") return to === "on" ? "电源已开启" : "电源已关闭";
  if (event.name === "link") return to === "online" ? "机台已连接" : "机台已断开";
  return event.name;
}

function DeviceOperations({ device }: { device: Machine }) {
  const { t } = useI18n();
  const { canWrite } = useMerchant();
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [action, setAction] = useState("");
  const [result, setResult] = useState("");
  const load = useCallback(
    () =>
      api<{ events: DeviceEvent[] }>(
        `/api/v1/merchant/machines/${device.id}/events`,
      ).then((r) => setEvents(r.events)),
    [device.id],
  );
  useEffect(() => {
    load().catch((e) => setResult(e.message));
  }, [load]);
  const labels: Record<string, string> = {
    "power.on": "开机",
    "power.off": "关机",
    coin: "投币",
    "door.open": "获取开门密码",
    "aime.scan": "刷卡",
    "card.state": "读卡状态变化",
    "card.consumed": "卡片已送入游戏",
    "led.set": "灯光",
  };
  // Actions follow the device's bound capabilities: a power binding offers
  // on/off, a HINATA IO binding offers card and coin, a lock offers a door code.
  // Direct-connect machines have no URL or password, so gating coin on those
  // hid the button entirely.
  const hasIo = device.hasHinata || device.relayConnection === "embedded";
  const canCoin = device.relayConnection === "embedded" || device.hasPassword;
  return (
    <div className="grid gap-5">
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {[
            ...(device.homeAssistant ? ["power.on", "power.off"] : []),
            ...(hasIo && canCoin ? ["coin"] : []),
            ...(device.ttlockLockId ? ["door.open"] : []),
          ].map((key) => (
            <button
              key={key}
              className={button}
              disabled={!device.enabled}
              onClick={() => setAction(key)}
            >
              {t(labels[key]!)}
            </button>
          ))}
        </div>
      )}
      {action && (
        <ActionForm
          label="确认操作"
          done={() => {
            setAction("");
            void load();
          }}
          submit={async () => {
            const r = await playerOperation<{ temporaryPassword?: string }>(
              `/api/v1/merchant/machines/${device.id}/actions`,
              { action },
            );
            setResult(
              r.temporaryPassword
                ? `${t("开门密码")} ${r.temporaryPassword}`
                : t("已发送"),
            );
          }}
        >
          <p className="text-sm">
            {device.name} · {t(labels[action]!)}
          </p>
        </ActionForm>
      )}
      {result && (
        <p role="status" className="select-all text-sm">
          {result}
        </p>
      )}
      <h3 className="text-sm font-semibold">{t("设备事件")}</h3>
      {!events.length && <State empty />}
      <div className="divide-y divide-ink/10">
        {timeline(events).map(({ event: e, result }) => {
          const inbound = e.kind === "signal";
          const outcome = result ? String(result.payload.outcome) : null;
          return (
            <div className="flex justify-between gap-3 py-3 text-sm" key={e.id}>
              <div>
                <span className="flex items-center gap-1.5">
                  {/* Direction is the difference between "we asked" and "the
                      machine reported", which is what makes a card event worth
                      logging at all. */}
                  {e.kind !== "change" && (
                    <span
                      className={inbound ? "text-mint" : "text-ink/45"}
                      title={inbound ? t("机台回报") : t("平台下发")}
                    >
                      {inbound ? "←" : "→"}
                    </span>
                  )}
                  {t(e.kind === "change" ? changeLabel(e) : labels[e.name] ?? e.name)}
                </span>
                <p className="mt-1 text-xs text-ink/50">{date(e.at)}</p>
              </div>
              <span className="text-xs text-ink/55">
                {e.kind === "signal"
                  ? t("机台回报")
                  : e.kind === "change"
                    ? t(e.origin === "observer" ? "检测到" : "机台回报")
                    : outcome === "ok"
                      ? t("已完成")
                      : outcome === "failed"
                        ? t("失败")
                        : t("结果待确认")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
