import { useEffect, useState } from "react";
import { api } from "../../api";
import { useI18n } from "../../i18n";
import { ActionForm, Field, input, useMerchant } from "./shared";

/** The shop's idle power-off rules, as the server stores them. */
export type IdleSettings = {
  shopEmpty: { enabled: boolean; minutes: number };
  device: { enabled: boolean; minutes: number; whileOccupied: "mark" | "remind" | "off" };
  devices: Record<string, { exclude?: boolean }>;
};

export const idlePath = (shopId: string, path = "") =>
  `/api/v1/merchant/idle-power${path}?shopId=${encodeURIComponent(shopId)}`;

export function useIdleSettings(shopId: string) {
  const [settings, setSettings] = useState<IdleSettings | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    api<{ settings: IdleSettings }>(idlePath(shopId))
      .then((result) => current && setSettings(result.settings))
      .catch(() => current && setSettings(null));
    return () => {
      current = false;
    };
  }, [shopId, revision]);
  return { settings, reload: () => setRevision((value) => value + 1) };
}

/**
 * Switching machines off when nobody uses them. Shop-wide: everything goes off
 * once the shop has been empty for a while. Per device: a machine that has
 * been free for the idle time is handled as the owner chooses while players
 * are in.
 */
export function IdlePowerSettings() {
  const { t } = useI18n();
  const { shopId } = useMerchant();
  const { settings, reload } = useIdleSettings(shopId);
  const [emptyOn, setEmptyOn] = useState(false);
  const [deviceOn, setDeviceOn] = useState(false);
  useEffect(() => {
    if (!settings) return;
    setEmptyOn(settings.shopEmpty.enabled);
    setDeviceOn(settings.device.enabled);
  }, [settings]);
  if (!settings) return null;
  return (
    <section className="rounded-xl border border-ink/10 bg-panel p-5">
      <h4 className="mb-1 font-semibold">{t("闲置自动关机")}</h4>
      <p className="mb-4 text-sm leading-relaxed text-ink/60">
        {t("有人占用的设备不会被关闭；开机或延迟关机后，在资源的占用时长内也算有人。设置为不自动关机的设备不受影响。")}
      </p>
      <ActionForm
        label="保存闲置设置"
        done={reload}
        submit={(f) =>
          api(idlePath(shopId), {
            method: "PUT",
            body: JSON.stringify({
              shopEmpty: { enabled: emptyOn, minutes: Number(f.get("emptyMinutes")) || 15 },
              device: {
                enabled: deviceOn,
                minutes: Number(f.get("deviceMinutes")) || settings.device.minutes,
                whileOccupied: String(f.get("whileOccupied") ?? settings.device.whileOccupied),
              },
            }),
          })
        }
      >
        <div className="grid gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={emptyOn} onChange={(e) => setEmptyOn(e.target.checked)} />
            {t("店铺闲置自动关闭设备")}
          </label>
          {emptyOn && (
            <Field label="店铺闲置判定时长" unit="分钟">
              <input className={input} type="number" min="1" max="1440" name="emptyMinutes" defaultValue={settings.shopEmpty.minutes} required />
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={deviceOn} onChange={(e) => setDeviceOn(e.target.checked)} />
            {t("设备闲置自动处理")}
          </label>
          {deviceOn && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="闲置判定时长" unit="分钟">
                <input className={input} type="number" min="1" max="1440" name="deviceMinutes" defaultValue={settings.device.minutes} required />
              </Field>
              <Field label="店里有人时，闲置的设备">
                <select className={input} name="whileOccupied" defaultValue={settings.device.whileOccupied}>
                  <option value="mark">{t("只标记为闲置")}</option>
                  <option value="remind">{t("通过 Bot 提醒")}</option>
                  <option value="off">{t("直接关机")}</option>
                </select>
              </Field>
            </div>
          )}
        </div>
      </ActionForm>
    </section>
  );
}
