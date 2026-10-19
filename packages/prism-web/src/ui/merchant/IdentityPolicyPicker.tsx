import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { IdentityPolicy } from "./setup-guide";

/**
 * Binding first, because it is what makes a player traceable and lets a shop
 * admit only its group's members. "Existing profiles only" is a migration
 * setting, so it sits under binding instead of beside it.
 */
export function IdentityPolicyPicker({
  value,
  change,
  name = "identity-policy",
}: {
  value: IdentityPolicy;
  change: (value: IdentityPolicy) => void;
  name?: string;
}) {
  const { t } = useI18n();
  const binding = value !== "web";
  const option = (
    checked: boolean,
    select: () => void,
    title: string,
    description: string,
    extra?: ReactNode,
  ) => (
    <div className={`rounded-lg border p-3 text-sm ${checked ? "border-mint bg-mint/5" : "border-ink/15"}`}>
      <label className="flex cursor-pointer gap-3">
        <input className="mt-1" type="radio" name={name} checked={checked} onChange={select} />
        <span>
          <strong className="block">{t(title)}</strong>
          <span className="mt-1 block leading-relaxed text-ink/60">{t(description)}</span>
        </span>
      </label>
      {extra}
    </div>
  );
  return (
    <div className="grid gap-2">
      {option(
        binding,
        () => change(value === "existing" ? "existing" : "bot"),
        "要求绑定平台身份（推荐）",
        "玩家第一次进店前，把网页上的绑定码发给店铺 Bot。店家因此知道每位玩家的 QQ 号等身份；Bot 只在店铺群里响应时，只有群成员能进店。需要接入 Bot。",
        binding && (
          <label className="ml-7 mt-3 flex cursor-pointer gap-2 border-t border-ink/10 pt-3">
            <input
              className="mt-0.5"
              type="checkbox"
              checked={value === "existing"}
              onChange={(event) => change(event.target.checked ? "existing" : "bot")}
            />
            <span>
              <span className="block">{t("只允许已有档案的玩家绑定")}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink/55">
                {t("用于从旧系统迁移、玩家档案已导入的店。勾选后，没有档案的新玩家无法通过 Bot 绑定，需要店员确认绑定码。")}
              </span>
            </span>
          </label>
        ),
      )}
      {option(
        !binding,
        () => change("web"),
        "登录网页账号即可",
        "玩家用 MuNET 或 Passkey 登录后直接进店，不需要 Bot。店家只知道玩家的 PRiSM 账号，不知道他在 QQ 等平台的身份。",
      )}
    </div>
  );
}
