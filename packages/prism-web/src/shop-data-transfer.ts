import { api, ApiError } from "./api";
import { convertPrismNeoSnapshot } from "./prism-neo-convert";

type Row = Record<string, string | number | null>;
type Header = Record<string, unknown>;
export type ExportInfo = {
  jobId: string;
  headerJson: string;
  tables: string[];
  counts: Record<string, number>;
  filename: string;
};
type Page = {
  rows: { seq: number; table_name: string; payload_json: string }[];
  cursor: number;
  done: boolean;
};
const invalid = () => new Error("请选择有效的 JSON 备份文件");
const encoder = new TextEncoder();

/** A JSON reader holds one value, rather than loading the full file or an entire table. */
class JsonReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private offset = 0;
  private ended = false;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  async peek(): Promise<string> {
    while (this.offset === this.buffer.length && !this.ended) {
      const next = await this.reader.read();
      this.buffer = next.done ? this.decoder.decode() : this.decoder.decode(next.value, { stream: true });
      this.offset = 0;
      this.ended = !!next.done;
    }
    return this.buffer[this.offset] ?? "";
  }
  async whitespace() {
    while (/\s/.test(await this.peek()) && (await this.peek())) this.offset++;
  }
  async expect(char: string) {
    await this.whitespace();
    if ((await this.peek()) !== char) throw invalid();
    this.offset++;
  }
  async value(): Promise<unknown> {
    await this.whitespace();
    const first = await this.peek();
    if (!first) throw invalid();
    const parts: string[] = [];
    let start = this.offset,
      depth = 0,
      quoted = false,
      escaped = false,
      size = 0;
    const append = () => {
      const piece = this.buffer.slice(start, this.offset);
      parts.push(piece);
      size += piece.length;
      if (size > 16 * 1024 * 1024) throw new Error("单条记录超过数据库可支持的大小");
    };
    for (;;) {
      if (this.offset === this.buffer.length) {
        append();
        await this.peek();
        start = this.offset;
      }
      const char = this.buffer[this.offset];
      if (!char || (!quoted && depth === 0 && /[\s,}\]]/.test(char))) {
        append();
        break;
      }
      this.offset++;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          quoted = false;
          if (depth === 0) {
            append();
            break;
          }
        }
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) {
          append();
          break;
        }
      }
    }
    try {
      return JSON.parse(parts.join(""));
    } catch {
      throw invalid();
    }
  }
  async done() {
    await this.whitespace();
    if (await this.peek()) throw invalid();
  }
  async close() {
    await this.reader.cancel();
  }
}

export async function readShopBackup(
  stream: ReadableStream<Uint8Array>,
  callbacks: {
    header: (header: Header) => Promise<void>;
    row: (table: string, row: Row) => Promise<void>;
    tableEnd: (table: string, count: number) => Promise<void>;
  },
): Promise<Record<string, number>> {
  const reader = new JsonReader(stream),
    header: Header = {},
    keys = new Set<string>(),
    counts: Record<string, number> = {};
  try {
    await reader.expect("{");
    let first = true,
      seenTables = false;
    for (;;) {
      await reader.whitespace();
      if ((await reader.peek()) === "}") {
        await reader.expect("}");
        break;
      }
      if (!first) await reader.expect(",");
      first = false;
      const key = await reader.value();
      if (typeof key !== "string" || keys.has(key)) throw invalid();
      keys.add(key);
      await reader.expect(":");
      if (key !== "tables") {
        if (seenTables) throw invalid();
        Object.defineProperty(header, key, { value: await reader.value(), enumerable: true });
        continue;
      }
      seenTables = true;
      await callbacks.header(header);
      await reader.expect("{");
      let firstTable = true;
      for (;;) {
        await reader.whitespace();
        if ((await reader.peek()) === "}") {
          await reader.expect("}");
          break;
        }
        if (!firstTable) await reader.expect(",");
        firstTable = false;
        const table = await reader.value();
        if (typeof table !== "string" || Object.hasOwn(counts, table)) throw invalid();
        Object.defineProperty(counts, table, { value: 0, writable: true, enumerable: true });
        await reader.expect(":");
        await reader.expect("[");
        let firstRow = true;
        for (;;) {
          await reader.whitespace();
          if ((await reader.peek()) === "]") {
            await reader.expect("]");
            break;
          }
          if (!firstRow) await reader.expect(",");
          firstRow = false;
          const row = await reader.value();
          if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid();
          await callbacks.row(table, row as Row);
          counts[table]!++;
        }
        await callbacks.tableEnd(table, counts[table]!);
      }
    }
    if (!seenTables) throw invalid();
    await reader.done();
    return counts;
  } finally {
    await reader.close();
  }
}

export type ShopBackupDigest = {
  header: Header;
  counts: Record<string, number>;
  /** The whole backup, already parsed client-side; upload just re-streams it. */
  file: Blob;
};

/**
 * Phase one, entirely client-side: parse the whole backup before the first
 * request. A structurally invalid file never creates a job and never sends a
 * part, so a bad file cannot consume Worker requests or import quota.
 */
export async function verifyShopBackup(
  file: Blob,
  progress: (count: number) => void,
): Promise<ShopBackupDigest> {
  const counts: Record<string, number> = {};
  let header: Header | undefined;
  let total = 0;
  await readShopBackup(file.stream(), {
    async header(value) {
      header = value;
    },
    async row(table) {
      counts[table] = (counts[table] ?? 0) + 1;
      total++;
    },
    async tableEnd(table) {
      counts[table] = counts[table] ?? 0;
    },
  });
  if (!header) throw invalid();
  progress(total);
  return { header, counts, file };
}

/**
 * Phase two: create the job once and send its parts. The table keys are
 * checked against the server contract before any part is sent, so a file the
 * importer would reject is abandoned after one small request.
 */
export async function uploadShopBackup(
  path: string,
  digest: ShopBackupDigest,
  progress: (count: number) => void,
): Promise<{ jobId: string; counts: Record<string, number>; parts: number }> {
  const job = await api<{ jobId: string; tables: string[] }>(`${path}/imports`, {
    method: "POST",
    body: JSON.stringify(digest.header),
  });
  const jobId = job.jobId;
  const tables = job.tables;
  const counts = { ...digest.counts };
  // v2 business backups created before report archiving have no metadata table.
  if (
    digest.header.version === 2 &&
    digest.header.scope === "business" &&
    tables.includes("checkout_report_states") &&
    !Object.hasOwn(counts, "checkout_report_states")
  )
    counts.checkout_report_states = 0;
  if (Object.keys(counts).sort().join(",") !== [...tables].sort().join(",")) {
    await api(`${path}/imports/${jobId}`, { method: "DELETE" }).catch(() => {});
    throw invalid();
  }
  let part = 0,
    total = 0,
    activeTable = "",
    rows: Row[] = [],
    bytes = 2;
  const flush = async () => {
    if (!rows.length) return;
    const body = JSON.stringify({ table: activeTable, part, rows });
    // One unusually large row still fits D1's per-value limit; all ordinary parts are small.
    if (encoder.encode(body).length > 2 * 1024 * 1024) throw new Error("单条记录超过数据库可支持的大小");
    // Mobile networks occasionally mangle a request body; the server accepts
    // an identical part replay for free, so retry once before giving up.
    try {
      await api(`${path}/imports/${jobId}/parts`, { method: "POST", body });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 400) throw error;
      await api(`${path}/imports/${jobId}/parts`, { method: "POST", body });
    }
    part++;
    rows = [];
    bytes = 2;
    progress(total);
  };
  try {
    await readShopBackup(digest.file.stream(), {
      async header() {},
      async row(table, row) {
        if (activeTable !== table) {
          await flush();
          activeTable = table;
        }
        const size = encoder.encode(JSON.stringify(row)).length + 1;
        if (rows.length && (bytes + size > 256 * 1024 || rows.length >= 1000)) await flush();
        rows.push(row);
        bytes += size;
        total++;
      },
      async tableEnd() {
        await flush();
      },
    });
    return { jobId, counts, parts: part };
  } catch (error) {
    await api(`${path}/imports/${jobId}`, { method: "DELETE" }).catch(() => {});
    throw error;
  }
}

/**
 * A prism-neo export is either the CLI's JSON snapshot or a pg_dump text file
 * with COPY blocks. Both are parsed in the browser and converted into a PRiSM
 * v3 backup Blob so the import stays on the staged, quota-counted path.
 */
export async function convertPrismNeoFile(file: File, timeZone: string): Promise<File> {
  const text = await file.text();
  // The picker does not restrict extensions (iOS hides .sql otherwise), so
  // sniff the content: JSON snapshot or pg_dump COPY block, nothing else.
  // CREATE TABLE preambles push the first COPY block well past 4 KB, so scan
  // the first 512 KiB.
  const trimmed = text.trimStart();
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const looksLikeDump = /^COPY\s/m.test(text.slice(0, 512 * 1024));
  if (!looksLikeJson && !looksLikeDump) {
    throw new Error("数据损坏");
  }
  const snapshot = looksLikeJson ? JSON.parse(text) : snapshotFromPgDump(text);
  const backup = convertPrismNeoSnapshot(snapshot, {
    shopName: file.name.replace(/\.(sql|txt|json)$/i, ""),
    timeZone,
  });
  // `counts` is a client-side summary; the wire header carries only schema keys.
  const { counts, tables, ...header } = backup;
  const json = JSON.stringify({ ...header, tables });
  return new File([json], `prism-${backup.source.publicId}-${backup.exportedAt.slice(0, 10)}.json`, {
    type: "application/json",
  });
}

type CopyTables = Map<string, { columns: string[]; rows: string[][] }>;

function snapshotFromPgDump(sql: string): Record<string, unknown> {
  const tables: CopyTables = new Map();
  const lines = sql.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const copy = parseCopyHeader(lines[index]!);
    if (!copy) continue;
    const rows: string[][] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line === "\\.") break;
      rows.push(line.split("\t"));
    }
    tables.set(copy.tableName, { columns: copy.columns, rows });
  }
  const read = (table: string): Record<string, unknown>[] =>
    (tables.get(table)?.rows ?? []).filter((fields) => fields.length > 1 || fields[0] !== "").map((fields) => {
      const columns = tables.get(table)!.columns;
      if (fields.length !== columns.length) {
        // The file is cut short mid-row; the snapshot cannot be complete.
        throw new Error("数据损坏");
      }
      return Object.fromEntries(columns.map((column, index) => [column, decodeCopyField(fields[index]!)]));
    });
  return {
    exportedAt: new Date().toISOString(),
    users: read("User"),
    binds: read("Bind"),
    assetDefinitions: read("Asset"),
    userAssets: read("UserAsset"),
    userAssetLogs: read("UserAssetLog"),
    sessions: read("Session"),
    billingRules: read("BillingRule"),
    billingRecords: read("BillingRecord"),
    presents: read("Present"),
    redeems: read("Redeem"),
    redeemRecords: read("RedeemRecord"),
    coinRecords: read("CoinRecord"),
  };
}

function parseCopyHeader(line: string): { tableName: string; columns: string[] } | null {
  const match = /^COPY (?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\((.*)\)\s*FROM stdin;\s*$/.exec(line);
  if (!match) return null;
  return { tableName: match[1]!, columns: splitIdentifierList(match[2]!) };
}

function splitIdentifierList(input: string): string[] {
  const columns: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      columns.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) columns.push(current.trim());
  return columns;
}

function decodeCopyField(field: string): string | null {
  if (field === "\\N") return null;
  let decoded = "";
  for (let index = 0; index < field.length; index += 1) {
    const char = field[index]!;
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const next = field[index + 1];
    if (next === undefined) {
      decoded += "\\";
      continue;
    }
    index += 1;
    if (next === "b") decoded += "\b";
    else if (next === "f") decoded += "\f";
    else if (next === "n") decoded += "\n";
    else if (next === "r") decoded += "\r";
    else if (next === "t") decoded += "\t";
    else if (next >= "0" && next <= "7") {
      let octal = next;
      let endIndex = index;
      for (let offset = 1; offset < 3; offset += 1) {
        const digit = field[index + offset];
        if (digit === undefined || digit < "0" || digit > "7") break;
        octal += digit;
        endIndex = index + offset;
      }
      decoded += String.fromCharCode(Number.parseInt(octal, 8));
      index = endIndex;
    } else decoded += next;
  }
  return decoded;
}

/** Each page request has bounded Worker memory and an independent subrequest budget. */
const exportStorageKey = (path: string) => `prism.export:${path}`;export async function cancelShopExport(path: string, jobId: string) {
  try {
    await api(`${path}/exports/${encodeURIComponent(jobId)}`, { method: "DELETE", keepalive: true });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  if (typeof sessionStorage !== "undefined" && sessionStorage.getItem(exportStorageKey(path)) === jobId)
    sessionStorage.removeItem(exportStorageKey(path));
}
/** Only cancel the interrupted task remembered by this tab, never another tab's live export. */
export async function recoverInterruptedShopExport(path: string) {
  const navigation = typeof window === "undefined" ? undefined :
    window.performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (navigation?.type === "navigate") {
    // A newly opened tab can inherit sessionStorage from its opener. Do not cancel the opener's task.
    sessionStorage.removeItem(exportStorageKey(path));
    return;
  }
  const jobId = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(exportStorageKey(path));
  if (jobId) await cancelShopExport(path, jobId);
}
export async function downloadShopBackup(
  path: string,
  scope: string,
  progress: (count: number) => void,
  options: { signal?: AbortSignal; onStart?: (info: ExportInfo) => void } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let info: ExportInfo | undefined;
  const leave = () => {
    abort();
    if (!info) return;
    const url = `${path}/exports/${encodeURIComponent(info.jobId)}/cancel`;
    // Navigation cannot wait for finally; keepalive/beacon is best effort, with lease expiry as the fallback.
    if (typeof navigator === "undefined" || !navigator.sendBeacon?.(url))
      void api(url, { method: "POST", keepalive: true }).catch(() => {});
  };
  options.signal?.addEventListener("abort", abort);
  if (options.signal?.aborted) abort();
  if (typeof window !== "undefined") window.addEventListener("pagehide", leave);
  try {
    controller.signal.throwIfAborted();
    // Let creation finish so a cancellation during the initial count can still release its known job.
    info = await api<ExportInfo>(`${path}/exports`, { method: "POST", body: JSON.stringify({ scope }) });
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(exportStorageKey(path), info.jobId);
    options.onStart?.(info);
    progress(0);
    controller.signal.throwIfAborted();
    const chunks: BlobPart[] = [info.headerJson.slice(0, -1) + ',"tables":{'];
    let cursor = 0,
      index = 0,
      open = false,
      hasRows = false,
      total = 0;
    for (;;) {
      const page = await api<Page>(`${path}/exports/${info.jobId}/page?after=${cursor}`, { signal: controller.signal });
      if (page.done) break;
      if (page.cursor <= cursor || !page.rows.length) throw invalid();
      cursor = page.cursor;
      const pieces: string[] = [];
      for (const row of page.rows) {
        while (info.tables[index] !== row.table_name) {
          if (index >= info.tables.length) throw invalid();
          pieces.push(open ? "]" : `${JSON.stringify(info.tables[index])}:[]`, ",");
          index++;
          open = false;
          hasRows = false;
        }
        if (!open) {
          pieces.push(`${JSON.stringify(info.tables[index])}:[`);
          open = true;
        }
        if (hasRows) pieces.push(",");
        pieces.push(row.payload_json);
        hasRows = true;
        total++;
      }
      chunks.push(pieces.join(""));
      progress(total);
    }
    if (open) {
      chunks.push("]");
      index++;
    }
    while (index < info.tables.length) {
      if (index > 0) chunks.push(",");
      chunks.push(`${JSON.stringify(info.tables[index++])}:[]`);
    }
    chunks.push("}}");
    const expected = Object.values(info.counts).reduce((sum, n) => sum + n, 0);
    if (total !== expected) throw new Error("备份记录数量不一致，请重新导出");
    return { info, blob: new Blob(chunks, { type: "application/json" }) };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", leave);
    if (info) await cancelShopExport(path, info.jobId).catch(() => {});
  }
}
