import { useEffect, useState } from "react";
import { api } from "../../api";
import { useI18n } from "../../i18n";
import { ActionForm, Field, input, useMerchant } from "./shared";

/** The shop's idle power-off rules, as the server stores them. */
export type IdleSettings = {
  shopEmpty: { enabled: boolean; minutes: number };
  device: { defaultMinutes: number; whileOccupied: "mark" | "remind" | "off" };
  devices: Record<string, { minutes?: number | null; exclude?: boolean }>;
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
 * once the shop has been empty for a while. Per device: a machine with no
 * activity for its idle time is handled as the owner chooses while players
 * are in, since the platform cannot tell who is playing which machine.
 */
export function IdlePowerSettings() {
  const { t } = useI18n();
  const { shopId } = useMerchant();
  const { settings, reload } = useIdleSettings(shopId);
  const [emptyOn, setEmptyOn] = useState(false);
  useEffect(() => {
    if (settings) setEmptyOn(settings.shopEmpty.enabled);
  }, [settings]);
  if (!settings) return null;
  return (
    <section className="rounded-xl border border-ink/10 bg-panel p-5">
      <h4 className="mb-1 font-semibold">{t("闲置自动关机")}</h4>
      <p className="mb-4 text-sm leading-relaxed text-ink/60">
        {t("刷卡、扫码投币、扫码开机都算有人在用。设置为不自动关机的设备不受影响。")}
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
                defaultMinutes: Number(f.get("deviceMinutes")) || 0,
                whileOccupied: String(f.get("whileOccupied")),
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
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="设备默认闲置判定时长" unit="分钟">
              <input
                className={input}
                type="number"
                min="0"
                max="1440"
                name="deviceMinutes"
                placeholder={t("不启用")}
                defaultValue={settings.device.defaultMinutes || ""}
              />
            </Field>
            <Field label="店里有人时，闲置的设备">
              <select className={input} name="whileOccupied" defaultValue={settings.device.whileOccupied}>
                <option value="mark">{t("只标记为闲置")}</option>
                <option value="remind">{t("通过 Bot 提醒")}</option>
                <option value="off">{t("直接关机")}</option>
              </select>
            </Field>
          </div>
        </div>
      </ActionForm>
    </section>
  );
}
