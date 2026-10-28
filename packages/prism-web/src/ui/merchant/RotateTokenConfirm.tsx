import { useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { button, input } from "./shared";

/** The word the shop types to unlock the final button; short, but not a click. */
const CONFIRM_WORD = "轮换";

/**
 * Rotating a token revokes the old one the moment the new one is minted: a bot
 * or a machine still holding it stops working, and the old value cannot be
 * brought back. One click is too cheap for that, so it takes three:
 *
 * 1. a button that says what it will do, opened on purpose;
 * 2. the consequence, read and accepted with a checkbox;
 * 3. the word 「轮换」 typed out, which is the only thing that renders the real
 *    submit button.
 *
 * Nothing is submitted by this component itself: `children` is the form's own
 * submit button, and it does not exist in the DOM until all three steps are
 * done. A stray Enter or a mis-click therefore cannot reach the server.
 */
export function RotateTokenConfirm({
  label,
  warn,
  children,
  disabled = false,
}: {
  /** What the confirmation is about, e.g. 「轮换 Bot 凭据」. */
  label: string;
  /** The consequence, told plainly: what stops working and what must be redone. */
  warn: string;
  /** The form's submit button, revealed only once the confirmation is complete. */
  children: ReactNode;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [accepted, setAccepted] = useState(false);
  const [typed, setTyped] = useState("");
  const reset = () => {
    setStep(0);
    setAccepted(false);
    setTyped("");
  };

  if (step === 0) {
    return (
      <button
        type="button"
        className={`${button} justify-self-start`}
        disabled={disabled}
        onClick={() => setStep(1)}
      >
        {t(label)}
      </button>
    );
  }

  return (
    <div className="grid gap-3 rounded-lg border border-coral/40 bg-coral/[0.06] p-3">
      <p className="text-sm font-medium text-coral">{t("这一步不可撤销")}</p>
      <p className="text-xs leading-relaxed text-ink/70">{t(warn)}</p>

      {step === 1 && (
        <>
          <p className="text-xs leading-relaxed text-ink/70">
            {t("确认后旧令牌立刻失效，正拿着它的 Bot 或机台会断线，要把新令牌重新填进去才能连上。")}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => setStep(2)}>
              {t("我明白，继续")}
            </button>
            <button type="button" className={button} onClick={reset}>
              {t("取消")}
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <label className="flex items-start gap-2 text-xs leading-relaxed">
            <input
              className="mt-0.5 shrink-0"
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>{t("我知道旧令牌取不回来，也知道该把它换到哪里。")}</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={!accepted} onClick={() => setStep(3)}>
              {t("继续")}
            </button>
            <button type="button" className={button} onClick={reset}>
              {t("取消")}
            </button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <label className="grid gap-1 text-xs leading-relaxed">
            <span>{t("最后一步：输入「{word}」两个字。", { word: CONFIRM_WORD })}</span>
            <input
              className={`${input} max-w-40`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              aria-label={t("输入确认词")}
              autoComplete="off"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {/* Rendered only when the word matches: there is no button to press before that. */}
            {typed.trim() === CONFIRM_WORD && children}
            <button type="button" className={button} onClick={reset}>
              {t("取消")}
            </button>
          </div>
          {typed.trim() !== CONFIRM_WORD && (
            <p className="text-xs text-ink/55">{t("输入正确的确认词后才会出现轮换按钮。")}</p>
          )}
        </>
      )}
    </div>
  );
}
