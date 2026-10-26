import { useI18n } from "../i18n";
import { useEffect, useState, type FormEvent } from "react";
import { Ban, ShieldCheck, Trash2, UserCog, X } from "lucide-react";
import { Api, api, type Ban as BanRecord, type User, type UserSummary } from "../api";
import { RequireLogin } from "./RequireLogin";
import { useAuth } from "./AuthContext";
import { Modal } from "./merchant/shared";

const roleLabels: Record<User["role"], string> = {
  user: "玩家",
  admin: "管理员",
};

const banLabels: Record<BanRecord["subjectType"], string> = {
  user: "账号",
  ip: "网络地址",
  card: "卡片",
  machine: "资源",
};

export function AdminPage() {
  const { t, errorText } = useI18n();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [bans, setBans] = useState<BanRecord[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadUsers = async (search = query) => {
    const result = await Api.adminUsers(search);
    setUsers(result.users);
  };

  const loadBans = async () => {
    const result = await Api.bans();
    setBans(result.bans);
  };

  useEffect(() => {
    void Promise.all([loadUsers(""), loadBans()]).catch((caught) => setError(caught instanceof Error ? caught.message : "无法加载管理信息"));
  }, []);

  return (
    <RequireLogin roles={["admin"]}>
      <section className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="grid content-start gap-4">
          <ExportAllowanceForm />
          <h1 className="text-2xl font-semibold">{t("账号管理")}</h1>
          <p className="text-sm text-ink/60">{t("删除测试账号后，再次用 MuNET 登录会重新进入注册流程。")}</p>
          {error && <p className="rounded border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">{errorText(error)}</p>}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void loadUsers();
            }}
          >
            <input className="focus-ring min-h-11 flex-1 rounded border border-ink/10 bg-surface px-3" placeholder={t("搜索 MuNET 用户")} value={query} onChange={(event) => setQuery(event.target.value)} />
            <button className="focus-ring rounded bg-ink px-4 font-medium text-canvas">{t("搜索")}</button>
          </form>
          <div className="grid gap-3">
            {users.map((user) => (
              <UserRow key={user.id} user={user} onChanged={() => loadUsers()} />
            ))}
          </div>
        </div>
        <div className="grid content-start gap-4">
          <BanForm onCreated={loadBans} />
          <div className="rounded border border-ink/10 bg-panel p-4">
            <h2 className="flex items-center gap-2 font-semibold">
              <Ban size={18} />
              {t("暂停名单")}</h2>
            <div className="mt-3 grid gap-2">
              {bans.length === 0 ? (
                <p className="rounded border border-dashed border-ink/20 bg-surface p-4 text-sm text-ink/60">{t("暂无记录。")}</p>
              ) : (
                bans.map((ban) => (
                  <div key={ban.id} className="rounded border border-ink/10 bg-surface p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{t(banLabels[ban.subjectType])} · {ban.subjectValue}</p>
                        <p className="mt-1 text-sm text-ink/60">{ban.reason}</p>
                      </div>
                      <button className="focus-ring grid size-8 shrink-0 place-items-center rounded text-coral hover:bg-coral/10" title={t("移除")} onClick={async () => {
                        await Api.deleteBan(ban.id);
                        await loadBans();
                      }}>
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
    </RequireLogin>
  );
}

function ExportAllowanceForm() {
  const { t, errorText } = useI18n();
  const [shopCode, setShopCode] = useState("");
  const [extra, setExtra] = useState(0);
  const [importExtra, setImportExtra] = useState(0);
  const [status, setStatus] = useState<{ month: string; timeZone: string; allowance: number; used: number; remaining: number; importAllowance: number; importUsed: number; importRemaining: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function request(save: boolean) {
    setBusy(true); setError("");
    try {
      const result = await api<NonNullable<typeof status>>(`/api/v1/admin/shops/${encodeURIComponent(shopCode.trim())}/transfer-allowance`,
        save ? { method: "PUT", body: JSON.stringify({ extra, importExtra }) } : undefined);
      setStatus(result); setExtra(result.allowance - 1); setImportExtra(result.importAllowance - 1);
    } catch (caught) { setError(errorText(caught instanceof Error ? caught.message : "操作失败")); }
    finally { setBusy(false); }
  }
  return <section className="grid gap-3 rounded border border-ink/10 bg-panel p-4">
    <h2 className="font-semibold">{t("店铺导入导出额度")}</h2>
    <p className="text-sm text-ink/60">{t("导入、导出分别默认每月一次。额外次数仅对店铺当前月份有效。")}</p>
    <label className="grid gap-1 text-sm">{t("店铺编号")}
      <input className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3" value={shopCode} disabled={busy}
        onChange={event => { setShopCode(event.target.value); setStatus(undefined); }} />
    </label>
    <button className="focus-ring min-h-11 rounded border border-ink/10 px-3 disabled:opacity-50" disabled={busy || !shopCode.trim()} onClick={() => void request(false)}>{t("查询额度")}</button>
    {status && <>
      <p className="text-sm">{status.month} · {status.timeZone}<br />{t("已使用")}: {status.used} · {t("剩余")}: {status.remaining}</p>
      <label className="grid gap-1 text-sm">{t("当月额外导出次数")}
        <input className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3" type="number" min={0} max={100} value={extra} disabled={busy} onChange={event => setExtra(Number(event.target.value))} />
      </label>
      <label className="grid gap-1 text-sm">{t("当月额外导入次数")}
        <input className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3" type="number" min={0} max={100} value={importExtra} disabled={busy} onChange={event => setImportExtra(Number(event.target.value))} />
      </label>
      <p className="text-sm">{t("本月剩余导入次数")}: {status.importRemaining}</p>
      <button className="focus-ring min-h-11 rounded bg-ink px-3 text-canvas disabled:opacity-50" disabled={busy || !Number.isInteger(importExtra) || importExtra < 0 || importExtra > 100 || !Number.isInteger(extra) || extra < 0 || extra > 100} onClick={() => void request(true)}>{t("保存额度")}</button>
    </>}
    {error && <p role="alert" className="text-sm text-coral">{error}</p>}
  </section>;
}

function UserRow({ user, onChanged }: { user: UserSummary; onChanged: () => void | Promise<void> }) {
  const { t, errorText } = useI18n();
  const { user: currentUser } = useAuth();
  const [role, setRole] = useState<User["role"]>(user.role);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const isCurrentUser = currentUser?.id === user.id;

  return (
    <article className="flex flex-wrap items-center justify-between gap-3 rounded border border-ink/10 bg-surface p-4">
      <div className="min-w-0">
        <p className="font-semibold">{user.displayName}</p>
        <p className="mt-1 text-sm text-ink/60">@{user.username} · {t("当前身份：")}{t(roleLabels[user.role])}</p>
        {isCurrentUser && <p className="mt-1 text-xs text-ink/60">{t("当前登录账号不能删除，请使用另一个管理员账号操作")}</p>}
      </div>
      <div className="flex items-center gap-2">
        <select className="focus-ring min-h-10 rounded border border-ink/10 bg-panel px-3" disabled={busy} value={role} onChange={(event) => setRole(event.target.value as User["role"])}>
          {Object.entries(roleLabels).map(([value, label]) => (
            <option key={value} value={value}>{t(label)}</option>
          ))}
        </select>
        <button
          className="focus-ring flex min-h-10 items-center gap-2 rounded bg-mint px-3 font-medium text-white disabled:opacity-60"
          disabled={busy || role === user.role}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await Api.setUserRole(user.id, role);
              await onChanged();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "操作失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          <UserCog size={17} />
          {t("保存")}</button>
        <button className="focus-ring flex min-h-10 items-center gap-2 rounded border border-coral/30 px-3 text-coral disabled:opacity-50"
          disabled={busy || isCurrentUser} onClick={() => { setError(""); setDeleting(true); }}>
          <Trash2 size={17} />{t("删除账号")}
        </button>
      </div>
      {error && !deleting && <p role="alert" className="w-full text-sm text-coral">{errorText(error)}</p>}
      {deleting && <Modal title="删除账号" dismissDisabled={busy} close={() => setDeleting(false)}>
        <div className="grid gap-4">
          <div><p className="font-semibold">{user.displayName} · @{user.username}</p><p className="mt-1 break-all text-xs text-ink/60">{user.id}</p></div>
          <p className="text-sm">{t("删除后无法恢复。该账号的登录资料、Passkey、卡片和店铺关联将被移除，下次 MuNET 登录会重新注册。")}</p>
          <p className="text-sm text-ink/60">{t("店铺、玩家账单和余额保留。已有其他负责人的店铺继续由其管理，无其他负责人的店铺由当前管理员接管。")}</p>
          {error && <p role="alert" className="text-sm text-coral">{errorText(error)}</p>}
          <div className="flex justify-end gap-2">
            <button className="focus-ring min-h-10 rounded border border-ink/15 px-4" disabled={busy} onClick={() => setDeleting(false)}>{t("取消")}</button>
            <button className="focus-ring min-h-10 rounded bg-coral px-4 font-medium text-white disabled:opacity-60" disabled={busy} onClick={async () => {
              setBusy(true); setError("");
              try {
                await Api.deleteUser(user.id);
                setDeleting(false);
                await onChanged();
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "操作失败");
              } finally { setBusy(false); }
            }}>{t(busy ? "正在删除…" : "确认删除账号")}</button>
          </div>
        </div>
      </Modal>}
    </article>
  );
}

function BanForm({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [subjectType, setSubjectType] = useState<BanRecord["subjectType"]>("user");
  const [subjectValue, setSubjectValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await Api.createBan({ subjectType, subjectValue, reason });
      setSubjectValue("");
      setReason("");
      await onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded border border-ink/10 bg-panel p-4 shadow-soft">
      <h2 className="flex items-center gap-2 font-semibold">
        <ShieldCheck size={18} />
        {t("暂停使用")}</h2>
      <div className="mt-3 grid gap-3">
        <select className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3" value={subjectType} onChange={(event) => setSubjectType(event.target.value as BanRecord["subjectType"])}>
          {Object.entries(banLabels).map(([value, label]) => (
            <option key={value} value={value}>{t(label)}</option>
          ))}
        </select>
        <input className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3" placeholder={t("对象标识")} value={subjectValue} onChange={(event) => setSubjectValue(event.target.value)} required />
        <input className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3" placeholder={t("原因")} value={reason} onChange={(event) => setReason(event.target.value)} required />
        <button className="focus-ring min-h-11 rounded bg-ink px-4 font-medium text-canvas disabled:opacity-60" disabled={busy}>
          {t("添加")}</button>
      </div>
    </form>
  );
}
