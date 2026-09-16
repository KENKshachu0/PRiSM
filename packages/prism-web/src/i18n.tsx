import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import english from "./locales/en.json";

export type Locale = "zh" | "en";
type Values = Record<string, string | number>;
const translations: Record<string, string> = english;
const LOCALE_STORAGE_KEY = "prism.locale";

export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "zh" || base === "en") return base;
  }
  return "en";
}

function storedLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return value === "zh" || value === "en" ? value : null;
  } catch {
    return null;
  }
}

export function translate(message: string, locale: Locale, values: Values = {}): string {
  const text = locale === "en" && Object.hasOwn(translations, message) ? translations[message]! : message;
  return text.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

export function translateError(message: string, locale: Locale): string {
  if (Object.hasOwn(translations, message)) return translate(message, locale);
  // Upstream diagnostics are not UI copy. Known API messages are translated above.
  return translate("操作失败，请稍后重试", locale);
}

const I18nContext = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (message: string, values?: Values) => string;
  errorText: (message: string) => string;
} | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    storedLocale() ?? resolveLocale(navigator.languages),
  );
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Ignore storage failures and keep the selection for this page.
    }
  }, []);
  useEffect(() => {
    const changed = () => setLocaleState(storedLocale() ?? resolveLocale(navigator.languages));
    window.addEventListener("languagechange", changed);
    return () => window.removeEventListener("languagechange", changed);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);
  const value = useMemo(() => ({
    locale,
    setLocale,
    t: (message: string, values?: Values) => translate(message, locale, values),
    errorText: (message: string) => translateError(message, locale),
  }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
