import { useEffect, useState } from "react";
import { api } from "../../api";
import { useI18n } from "../../i18n";
import { Field, buttonQuiet, input } from "./shared";

/** A shop Home Assistant connection as the board sees it; tokens never come back. */
export type HaConnection = {
  id: string;
  url: string;
  internalUrl: string | null;
  readAccess: "ready" | "needs_admin" | "failed" | null;
  readError: string | null;
  devices: number;
};

export const NEW_CONNECTION = "new";

/** What a power or air-conditioner binding is being edited to. */
export type HaDraft = { connection: string; url: string; token: string; entityId: string };

/** The body the device save expects for one Home Assistant entity. */
export function haBody(draft: HaDraft) {
  return draft.connection === NEW_CONNECTION
    ? { url: draft.url.trim(), entityId: draft.entityId.trim(), ...(draft.token.trim() ? { token: draft.token.trim() } : {}) }
    : { connectionId: draft.connection, entityId: draft.entityId.trim() };
}

export function useHaConnections(shopId: string) {
  const [connections, setConnections] = useState<HaConnection[] | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    api<{ connections: HaConnection[] }>(`/api/v1/merchant/ha-connections?shopId=${encodeURIComponent(shopId)}`)
      .then((result) => current && setConnections(result.connections))
      .catch(() => current && setConnections([]));
    return () => {
      current = false;
    };
  }, [shopId, revision]);
  return { connections, reload: () => setRevision((value) => value + 1) };
}

/**
 * Choose which of the shop's Home Assistants an entity lives on, or add one, and
 * pick the entity from the list that Home Assistant reports.
 */
export function HaEntityFields({
  shopId,
  connections,
  draft,
  change,
  domains,
  entityLabel,
  entityPlaceholder,
  tokenOptional,
  reload,
}: {
  shopId: string;
  connections: HaConnection[];
  draft: HaDraft;
  change: (next: HaDraft) => void;
  domains: string[];
  entityLabel: string;
  entityPlaceholder: string;
  /** A token is not needed: the device already has one, or another capability's is reused. */
  tokenOptional: boolean;
  reload: () => void;
}) {
  const { t } = useI18n();
  const selected = connections.find((connection) => connection.id === draft.connection) ?? null;
  const [entities, setEntities] = useState<{ entityId: string; name: string }[]>([]);
  useEffect(() => {
    let current = true;
    setEntities([]);
    if (!selected) return;
    api<{ entities: { entityId: string; name: string }[] }>(
      `/api/v1/merchant/ha-connections/${encodeURIComponent(selected.id)}/entities?shopId=${encodeURIComponent(shopId)}`,
    )
      .then((result) => current && setEntities(result.entities.filter((entity) => domains.includes(entity.entityId.split(".")[0]!))))
      // The list is a convenience; the entity can still be typed.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [selected?.id, shopId, domains.join(",")]);
  const listId = `ha-entities-${domains.join("-")}`;
  return (
    <div className="grid gap-3">
      {connections.length > 0 && (
        <Field label="Home Assistant">
          <select className={input} value={draft.connection} onChange={(e) => change({ ...draft, connection: e.target.value })}>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>{connection.url}</option>
            ))}
            <option value={NEW_CONNECTION}>{t("添加另一个 Home Assistant…")}</option>
          </select>
        </Field>
      )}
      {draft.connection === NEW_CONNECTION && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Home Assistant 地址">
            <input
              className={input}
              type="url"
              required
              placeholder="https://ha.example.com"
              value={draft.url}
              onChange={(e) => change({ ...draft, url: e.target.value })}
            />
          </Field>
          <Field label="长期访问令牌" unit={tokenOptional ? "已设置" : undefined}>
            <input
              className={input}
              type="password"
              required={!tokenOptional}
              autoComplete="new-password"
              value={draft.token}
              placeholder={tokenOptional ? "••••••••" : ""}
              onChange={(e) => change({ ...draft, token: e.target.value })}
            />
          </Field>
        </div>
      )}
      <Field label={entityLabel}>
        <input
          className={`${input} font-mono`}
          required
          list={entities.length ? listId : undefined}
          placeholder={entityPlaceholder}
          value={draft.entityId}
          onChange={(e) => change({ ...draft, entityId: e.target.value.trim() })}
        />
        {entities.length > 0 && (
          <datalist id={listId}>
            {entities.map((entity) => (
              <option key={entity.entityId} value={entity.entityId}>{entity.name}</option>
            ))}
          </datalist>
        )}
      </Field>
      {selected && <LiveStateStatus shopId={shopId} connection={selected} reload={reload} />}
    </div>
  );
}

/**
 * Whether the shop's game PCs can watch this Home Assistant with a token that
 * switches nothing. The account is made automatically with an administrator's
 * token; otherwise one can be pasted here once and is not kept.
 */
function LiveStateStatus({ shopId, connection, reload }: { shopId: string; connection: HaConnection; reload: () => void }) {
  const { t } = useI18n();
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const retry = async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ access: string; error: string | null }>(
        `/api/v1/merchant/ha-connections/${encodeURIComponent(connection.id)}/read-access?shopId=${encodeURIComponent(shopId)}`,
        { method: "POST", body: JSON.stringify(adminToken.trim() ? { adminToken: adminToken.trim() } : {}) },
      );
      setAdminToken("");
      if (result.access === "needs_admin") setMessage(t("这个令牌不是管理员的"));
      else if (result.error) setMessage(result.error);
      reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("操作失败"));
    } finally {
      setBusy(false);
    }
  };
  if (connection.readAccess === "ready")
    return <p className="text-xs text-ink/50">{t("实时状态已启用")}</p>;
  return (
    <div className="grid gap-2 rounded-lg bg-ink/5 p-3 text-xs leading-relaxed text-ink/65">
      <p>
        {connection.readAccess === "failed"
          ? t("实时状态未启用：{reason}", { reason: connection.readError ?? t("未知原因") })
          : connection.readAccess === "needs_admin"
            ? t("实时状态需要一次 Home Assistant 管理员令牌，用来创建只读账号，用完不保存。")
            : t("正在启用实时状态…")}
      </p>
      {connection.readAccess !== null && (
        <div className="flex gap-2">
          <input
            className={input}
            type="password"
            autoComplete="new-password"
            aria-label={t("管理员令牌")}
            placeholder={t("管理员令牌")}
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
          />
          <button type="button" className={`${buttonQuiet} shrink-0 px-3`} disabled={busy} onClick={() => void retry()}>
            {t(connection.readAccess === "failed" && !adminToken ? "重试" : "启用")}
          </button>
        </div>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
