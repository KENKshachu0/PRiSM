import { useI18n } from "../../i18n";
import type { IdentityPolicy } from "./setup-guide";

const identityOptions: [IdentityPolicy, string, string][] = [
  [
    "web",
    "登录网页账号即可",
    "玩家用 MuNET 或 Passkey 登录后直接入场，不需要 Bot。适合大多数新店。",
  ],
  [
    "bot",
    "绑定 Bot 身份，自动建档",
    "玩家先把网页上的绑定码发给店铺 Bot，首次绑定时自动创建玩家档案。需要先接入 Bot。",
  ],
  [
    "existing",
    "绑定 Bot 身份，只认已有档案",
    "只有已有档案的平台身份能完成绑定，适合从旧系统迁移的店；没有档案的新玩家由店员确认绑定码后建档。",
  ],
];

/** The two identity switches as the three policies they actually combine into. */
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
  return (
    <div className="grid gap-2">
      {identityOptions.map(([id, title, description]) => (
        <label
          key={id}
          className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${value === id ? "border-mint bg-mint/5" : "border-ink/15"}`}
        >
          <input
            className="mt-1"
            type="radio"
            name={name}
            checked={value === id}
            onChange={() => change(id)}
          />
          <span>
            <strong className="block">{t(title)}</strong>
            <span className="mt-1 block leading-relaxed text-ink/60">
              {t(description)}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
