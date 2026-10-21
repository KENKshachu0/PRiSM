import { parseLocalDateTime } from "@prism/core";
import type { Present, RedeemCode } from "./asset-types";

/** How much of a code's use count has been spent. A revoked code has its limit set to 0. */
export type CodeUsage = "unused" | "partial" | "exhausted" | "revoked";
/** Where a code sits against its own activation and expiry window. */
export type CodeValidity = "valid" | "pending" | "expired";

export type CodeExportFilter = {
  /** Empty means every present. */
  presentIds: readonly string[];
  /** Empty means every usage state. */
  usage: readonly CodeUsage[];
  /** Empty means every validity state. */
  validity: readonly CodeValidity[];
  /** Case-insensitive substring of the code itself, e.g. a batch prefix. */
  search: string;
  /** Local dates (YYYY-MM-DD) in the shop's time zone, inclusive. Codes that never expire fall outside any set range. */
  expiresFrom: string;
  expiresTo: string;
  /** Keep only the first N matches in list order; blank for all. */
  limit: string;
};

export const emptyCodeExportFilter: CodeExportFilter = {
  presentIds: [],
  usage: [],
  validity: [],
  search: "",
  expiresFrom: "",
  expiresTo: "",
  limit: "",
};

export function codeUsage(code: RedeemCode): CodeUsage {
  if (code.maxUseCount <= 0) return "revoked";
  if (code.usageCount >= code.maxUseCount) return "exhausted";
  return code.usageCount > 0 ? "partial" : "unused";
}

export function codeValidity(code: RedeemCode, now: Date): CodeValidity {
  if (code.expiresAt && new Date(code.expiresAt) <= now) return "expired";
  if (code.activeAt && new Date(code.activeAt) > now) return "pending";
  return "valid";
}

export function filterRedeemCodes(
  codes: readonly RedeemCode[],
  filter: CodeExportFilter,
  now: Date,
  timeZone: string,
): RedeemCode[] {
  const search = filter.search.trim().toLowerCase();
  const from = filter.expiresFrom ? parseLocalDateTime(filter.expiresFrom, "00:00", timeZone) : null;
  // The "to" day is inclusive, so the cut is the first minute after its last one.
  const before = filter.expiresTo
    ? new Date(parseLocalDateTime(filter.expiresTo, "23:59", timeZone).getTime() + 60_000)
    : null;
  const limit = Number.parseInt(filter.limit, 10);

  const matches = codes.filter((code) => {
    if (filter.presentIds.length && !filter.presentIds.includes(code.presentId)) return false;
    if (filter.usage.length && !filter.usage.includes(codeUsage(code))) return false;
    if (filter.validity.length && !filter.validity.includes(codeValidity(code, now))) return false;
    if (search && !code.code.toLowerCase().includes(search)) return false;
    if (from || before) {
      if (!code.expiresAt) return false;
      const expires = new Date(code.expiresAt);
      if (from && expires < from) return false;
      if (before && expires >= before) return false;
    }
    return true;
  });
  return Number.isInteger(limit) && limit > 0 ? matches.slice(0, limit) : matches;
}

export type CodeExportColumn =
  | "present"
  | "usageCount"
  | "maxUseCount"
  | "usage"
  | "validity"
  | "activeAt"
  | "expiresAt";

export type CodeExportLabels = {
  code: string;
  columns: Record<CodeExportColumn, string>;
  usage: Record<CodeUsage, string>;
  validity: Record<CodeValidity, string>;
};

export const codeExportColumns: readonly CodeExportColumn[] = [
  "present",
  "usageCount",
  "maxUseCount",
  "usage",
  "validity",
  "activeAt",
  "expiresAt",
];

/** One code per line, for pasting into a sales channel or a print template. */
export function redeemCodesToText(codes: readonly RedeemCode[]): string {
  return codes.map((code) => code.code).join("\n") + (codes.length ? "\n" : "");
}

export function redeemCodesToCsv(
  codes: readonly RedeemCode[],
  presents: readonly Pick<Present, "id" | "name">[],
  columns: readonly CodeExportColumn[],
  labels: CodeExportLabels,
  now: Date,
  formatDate: (value: string | null | undefined) => string,
): string {
  const presentName = new Map(presents.map((present) => [present.id, present.name]));
  const value = (code: RedeemCode, column: CodeExportColumn): string | number => {
    switch (column) {
      case "present":
        return presentName.get(code.presentId) ?? "";
      case "usageCount":
        return code.usageCount;
      case "maxUseCount":
        return code.maxUseCount;
      case "usage":
        return labels.usage[codeUsage(code)];
      case "validity":
        return labels.validity[codeValidity(code, now)];
      case "activeAt":
        return code.activeAt ? formatDate(code.activeAt) : "";
      case "expiresAt":
        return code.expiresAt ? formatDate(code.expiresAt) : "";
    }
  };
  const rows = [
    [quote(labels.code), ...columns.map((column) => quote(labels.columns[column]))],
    ...codes.map((code) => [quote(code.code), ...columns.map((column) => csvCell(value(code, column)))]),
  ];
  return rows.map((row) => row.join(",")).join("\r\n") + "\r\n";
}

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * A free-text field (a present name) that opens with = + - @ would run as a
 * formula when the file is opened in Excel, so it is prefixed to stay text. The
 * code column is exempt: it must round-trip exactly.
 */
function csvCell(raw: string | number): string {
  const text = String(raw);
  return quote(typeof raw === "string" && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
}
