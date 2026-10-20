import { Minus, Plus, Snowflake } from "lucide-react";
import { useI18n } from "../i18n";

/** What a climate entity reports, as returned by the device state endpoints. */
export type ClimateState = {
  mode: string;
  modes: string[];
  temperature: number | null;
  currentTemperature: number | null;
  minTemperature: number | null;
  maxTemperature: number | null;
  temperatureStep: number | null;
  fanMode: string | null;
  fanModes: string[];
};

const modeNames: Record<string, string> = {
  off: "已关闭",
  cool: "制冷",
  heat: "制热",
  dry: "除湿",
  fan_only: "送风",
  auto: "自动",
  heat_cool: "自动冷暖",
};

/** Integrations name fan speeds freely; the common ones get a Chinese label. */
const fanNames: Record<string, string> = {
  auto: "自动",
  silent: "静音",
  quiet: "静音",
  low: "低风",
  medium: "中风",
  middle: "中风",
  high: "高风",
  strong: "强劲",
  turbo: "强劲",
};

export const climateModeName = (mode: string) => modeNames[mode] ?? mode;
const fanName = (mode: string) => fanNames[mode.toLowerCase()] ?? mode;

/** One line for a header or a card: mode, target and room temperature. */
export function climateSummary(
  state: ClimateState | null,
  t: (message: string, values?: Record<string, string | number>) => string,
): string {
  if (!state) return t("空调状态未知");
  return [
    t(climateModeName(state.mode)),
    state.mode !== "off" && state.temperature !== null
      ? t("设定 {value}°", { value: state.temperature })
      : "",
    state.currentTemperature !== null
      ? t("室温 {value}°", { value: state.currentTemperature })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Air conditioner controls shared by the staff action panel and the player's
 * device page. Every option shown is one the entity itself reports, because
 * integrations differ in which modes, fan speeds and temperatures they take.
 * Each press is sent right away, like the rest of the device controls.
 */
export function ClimateControls({
  state,
  busy,
  disabled,
  send,
  powerClass,
  showSummary = true,
}: {
  state: ClimateState | null;
  /** The action in flight, if any. */
  busy: string;
  disabled: boolean;
  send: (action: string, extra?: Record<string, unknown>) => void;
  /** Class of the on/off button, so it matches the surface it sits on. */
  powerClass: string;
  showSummary?: boolean;
}) {
  const { t } = useI18n();
  const off = !state || state.mode === "off";
  const locked = disabled || !!busy;
  const step = state?.temperatureStep ?? 0.5;
  const min = state?.minTemperature ?? 16;
  const max = state?.maxTemperature ?? 30;
  const decimals = String(step).split(".")[1]?.length ?? 0;
  const shift = (delta: number) => {
    if (state?.temperature === null || state?.temperature === undefined) return;
    const next = Number(
      Math.min(max, Math.max(min, state.temperature + delta)).toFixed(decimals),
    );
    if (next !== state.temperature) send("climate.set_temperature", { temperature: next });
  };
  const modes = (state?.modes ?? []).filter((mode) => mode !== "off");
  return (
    <div className="climate-controls">
      {showSummary && (
        <p className="climate-summary">
          <Snowflake size={16} aria-hidden="true" />
          {climateSummary(state, t)}
        </p>
      )}
      <button
        type="button"
        className={powerClass}
        disabled={locked}
        onClick={() => send(off ? "climate.on" : "climate.off")}
      >
        {t(off ? "开空调" : "关空调")}
      </button>
      {modes.length > 0 && (
        <div className="climate-options" role="group" aria-label={t("模式")}>
          <span className="climate-label" aria-hidden="true">{t("模式")}</span>
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              className="climate-chip"
              aria-pressed={state?.mode === mode}
              disabled={locked}
              onClick={() => send("climate.set_mode", { mode })}
            >
              {t(climateModeName(mode))}
            </button>
          ))}
        </div>
      )}
      {!off && state?.temperature !== null && state?.temperature !== undefined && (
        <div className="climate-temperature" role="group" aria-label={t("设定温度")}>
          <span className="climate-label" aria-hidden="true">{t("温度")}</span>
          <button
            type="button"
            className="climate-chip"
            aria-label={t("调低温度")}
            disabled={locked || state.temperature <= min}
            onClick={() => shift(-step)}
          >
            <Minus size={18} />
          </button>
          <output aria-live="polite">{state.temperature}°</output>
          <button
            type="button"
            className="climate-chip"
            aria-label={t("调高温度")}
            disabled={locked || state.temperature >= max}
            onClick={() => shift(step)}
          >
            <Plus size={18} />
          </button>
        </div>
      )}
      {!off && !!state?.fanModes.length && (
        <div className="climate-options" role="group" aria-label={t("风速")}>
          <span className="climate-label" aria-hidden="true">{t("风速")}</span>
          {state.fanModes.map((mode) => (
            <button
              key={mode}
              type="button"
              className="climate-chip"
              aria-pressed={state.fanMode === mode}
              disabled={locked}
              onClick={() => send("climate.set_fan_mode", { fanMode: mode })}
            >
              {t(fanName(mode))}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
