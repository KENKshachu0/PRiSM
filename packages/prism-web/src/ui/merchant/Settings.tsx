import { ShopDataTransfer } from "./ShopDataTransfer";
import { IdentityConverter } from "./IdentityConverter";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Store, Receipt, Users, MapPin, Plug, ShieldCheck, Database } from "lucide-react";
import { useI18n } from "../../i18n";
import { BillingSettings } from "../BillingPages";
import {
  ActionForm,
  CopyValue,
  Field,
  Modal,
  State,
  Table,
  button,
  cell,
  date,
  input,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
} from "./shared";

type Settings = {
  store: { name: string; timeZone: string };
  operations: { coinCooldownMs: number };
  registration: { defaultPresentId: string | null };
  homeAssistantConnection: { url: string; token: string };
  homeAssistantDevices: { id: string; name: string; alias?: string[] }[];
  ttLockConnection?: {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    appAccount: string;
    appPwd: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt?: number | null;
  };
  ttLockDevices?: {
    id: string;
    name: string;
    aliases: string[];
    lockId: number;
  }[];
  hinataIoDevices: {
    id: string;
    name: string;
    url: string;
    password: string;
    salt: string;
    coinKey: number;
    cardType: string;
    aliases: string[];
  }[];
};
type Token = {
  id: string;
  label: string;
  role: string;
  status: string;
  lastUsedAt?: string | null;
};
const groups = [
  {
    id: "general",
    label: "基本资料",
    description: "店铺名称、封面、位置与时区。",
    icon: Store,
  },
  {
    id: "billing",
    label: "营业与计费",
    description: "入场计费、前台收银与收费规则。",
    icon: Receipt,
  },
  {
    id: "players",
    label: "玩家与身份",
    description: "玩家进店前如何确认身份、新玩家礼物与平台标识转换。",
    icon: Users,
  },
  {
    id: "devices",
    label: "位置与设备",
    description: "到店位置校验、投币冷却与门锁连接。",
    icon: MapPin,
  },
  {
    id: "integrations",
    label: "Bot 与接入",
    description: "让 QQ 等平台的店铺 Bot 代表玩家绑定身份、查询余额和操作设备。",
    icon: Plug,
  },
  {
    id: "data",
    label: "数据管理",
    description: "JSON 备份、恢复与跨环境迁移。",
    icon: Database,
  },
  {
    id: "members",
    label: "成员与权限",
    description: "管理店铺成员及其操作权限。",
    icon: ShieldCheck,
  },
] as const;

export function SettingsPage({
  shopDetails,
  members,
  guide = false,
}: {
  shopDetails: ReactNode;
  members: ReactNode;
  /** Link back to the setup guide once it has left the tab bar. */
  guide?: boolean;
}) {
  const { t } = useI18n();
  const { shopCode, owner } = useMerchant();
  const request = useStaffApi();
  const [params] = useSearchParams();
  const group =
    groups.find((item) => item.id === params.get("group")) ?? groups[0];
  const settings = useResource<{ settings: Settings }>(
    owner ? "settings" : null,
  );
  const gifts = useResource<{
    presents: { id: string; name: string; status: string }[];
  }>(owner ? "presents" : null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    window.addEventListener("prism-shop-settings", settings.reload);
    return () =>
      window.removeEventListener("prism-shop-settings", settings.reload);
  }, [settings.reload]);
  // Staff settings are a whole-document API; merge only this form's fields into the latest document.
  async function saveSettings(patch: Partial<Settings>) {
    const current = await request<{ settings: Settings }>("settings");
    await request("settings", "PUT", { ...current.settings, ...patch });
  }
  function saved(id: string) {
    setNotice(id);
    settings.reload();
  }
  if (!owner) return null;
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("店铺设置")}</h2>
        {guide && (
          <Link
            className="text-sm text-ink/60 underline hover:text-ink"
            to={`/merchant/${segment(shopCode)}/guide`}
          >
            {t("开店指引")}
          </Link>
        )}
      </header>
      <div className="grid gap-5 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <nav
          aria-label={t("设置分类")}
          className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:self-start"
        >
          {groups.map((item) => {
            const next = new URLSearchParams(params);
            next.set("group", item.id);
            return (
              <Link
                key={item.id}
                to={`?${next}`}
                aria-current={group.id === item.id ? "page" : undefined}
                className={`focus-ring flex shrink-0 items-center gap-2 rounded-lg px-3 py-3 text-sm ${group.id === item.id ? "bg-mint/10 font-semibold text-ink" : "text-ink/60 hover:bg-ink/5 hover:text-ink"}`}
              >
                <item.icon size={18} aria-hidden="true" />
                {t(item.label)}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0 space-y-5">
          <header>
            <h3 className="text-lg font-semibold">{t(group.label)}</h3>
            <p className="mt-1 text-sm leading-relaxed text-ink/60">
              {t(group.description)}
            </p>
          </header>
          {notice === group.id && (
            <p role="status" className="text-sm text-mint">
              {t("已保存")}
            </p>
          )}
          {/* Keep drafts and one-time credentials mounted when changing groups. */}
          <div hidden={group.id !== "general"}>{shopDetails}</div>
          <BillingSettings
            shopCode={shopCode}
            embedded
            section={
              group.id === "billing" ||
              group.id === "players" ||
              group.id === "devices"
                ? group.id
                : null
            }
          />
          <div hidden={group.id !== "players"}>
            <div className="grid gap-5">
              {!settings.data ? (
                <State error={settings.error} />
              ) : (
                <section className="rounded-xl border border-ink/10 bg-panel p-5">
                  <h4 className="mb-4 font-semibold">{t("新玩家礼物")}</h4>
                  {!gifts.data ? (
                    <State error={gifts.error} />
                  ) : !gifts.data.presents.some((p) => p.status !== "archived") ? (
                    <p className="text-sm text-ink/60">
                      {t("新玩家第一次进店时自动领取一份礼物，比如体验余额。先创建礼物再回来选择。")}{" "}
                      <Link
                        className="underline"
                        to={`/merchant/${segment(shopCode)}/assets?tab=gifts`}
                      >
                        {t("去创建礼物")}
                      </Link>
                    </p>
                  ) : (
                    <ActionForm
                      label="保存玩家礼物"
                      done={() => saved("players")}
                      submit={(f) =>
                        saveSettings({
                          registration: {
                            defaultPresentId:
                              String(f.get("present") || "") || null,
                          },
                        })
                      }
                    >
                      <Field label="新玩家礼物">
                        <select
                          className={input}
                          name="present"
                          defaultValue={
                            settings.data.settings.registration
                              .defaultPresentId ?? ""
                          }
                          disabled={!gifts.data}
                        >
                          <option value="">{t("无")}</option>
                          {gifts.data?.presents
                            .filter((p) => p.status !== "archived")
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                    </ActionForm>
                  )}
                </section>
              )}
              <details className="rounded-xl border border-ink/10 bg-panel p-5">
                <summary className="cursor-pointer font-semibold">
                  {t("平台身份转换")}
                </summary>
                <p className="mt-2 text-sm leading-relaxed text-ink/60">
                  {t("需要变更平台标识时使用，由店主预览后主动执行。")}
                </p>
                <div className="mt-5">
                  <IdentityConverter
                    key={shopCode}
                    shopCode={shopCode}
                    embedded
                  />
                </div>
              </details>
            </div>
          </div>
          <div hidden={group.id !== "devices"}>
            <div className="grid gap-5">
              {!settings.data ? (
                <State error={settings.error} />
              ) : (
                <>
                  <section className="rounded-xl border border-ink/10 bg-panel p-5">
                    <h4 className="mb-4 font-semibold">{t("投币设置")}</h4>
                    <ActionForm
                      label="保存投币设置"
                      done={() => saved("devices")}
                      submit={(f) =>
                        saveSettings({
                          operations: {
                            coinCooldownMs: Number(f.get("cooldown")) * 1000,
                          },
                        })
                      }
                    >
                      <Field label="投币冷却时间（秒）">
                        <input
                          className={input}
                          type="number"
                          min="0"
                          step="0.1"
                          name="cooldown"
                          defaultValue={
                            settings.data.settings.operations.coinCooldownMs /
                            1000
                          }
                          required
                        />
                      </Field>
                    </ActionForm>
                  </section>
                  <TTLockConnection
                    settings={settings.data.settings}
                    reload={settings.reload}
                  />
                </>
              )}
            </div>
          </div>
          <div hidden={group.id !== "integrations"}>
            <Tokens shopCode={shopCode} />
          </div>
          <div hidden={group.id !== "data"}><ShopDataTransfer key={shopCode} /></div>
          <div hidden={group.id !== "members"}>{members}</div>
        </div>
      </div>
    </div>
  );
}
function Tokens({ shopCode }: { shopCode: string }) {
  const { t } = useI18n();
  const request = useStaffApi();
  const tokens = useResource<{ apiTokens: Token[] }>("api-tokens");
  const [create, setCreate] = useState(false);
  const [secret, setSecret] = useState("");
  const [revoke, setRevoke] = useState<Token | null>(null);
  return (
    <section className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">{t("Bot 接入凭据")}</h3>
        <button type="button" className={button} onClick={() => setCreate(true)}>
          {t("创建凭据")}
        </button>
      </div>
      <div className="grid gap-3 rounded-lg border border-ink/10 bg-surface p-4">
        <p className="text-xs leading-relaxed text-ink/60">
          {t("在 Bot 的 PRiSM 插件（Koishi）里填入接入凭据、店铺编号和 API 地址。")}
        </p>
        <CopyValue label="店铺编号" value={shopCode} />
        <CopyValue label="API 地址" value={window.location.origin} />
      </div>
      {secret && (
        <div role="status" className="grid gap-3 rounded border border-mint/40 bg-mint/5 p-4">
          <p className="text-sm">{t("请保存凭据，关闭后不再显示。")}</p>
          <CopyValue label="接入凭据" value={secret} />
          <button type="button" className={`${button} justify-self-start`} onClick={() => setSecret("")}>
            {t("已保存，关闭")}
          </button>
        </div>
      )}
      {!tokens.data ? (
        <State error={tokens.error} />
      ) : !tokens.data.apiTokens.length ? (
        <p className="rounded-lg border border-dashed border-ink/20 px-4 py-6 text-center text-sm text-ink/60">
          {t("还没有凭据")}
        </p>
      ) : (
        <Table headers={["名称", "状态", "最近连接", "操作"]}>
          {tokens.data.apiTokens.map((token) => (
            <tr key={token.id}>
              <td className={cell}>
                {token.label}
                {token.role !== "integration" && (
                  <span className="ml-2 text-xs text-ink/50">{t("旧版机台凭据")}</span>
                )}
              </td>
              <td className={cell}>
                {t(token.status === "active" ? "有效" : "已撤销")}
              </td>
              <td className={cell}>
                {token.lastUsedAt ? date(token.lastUsedAt) : t("从未连接")}
              </td>
              <td className={cell}>
                {token.status === "active" && (
                  <button type="button" className={button} onClick={() => setRevoke(token)}>
                    {t("撤销")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {create && (
        <Modal title="创建凭据" close={() => setCreate(false)}>
          <ActionForm
            done={() => {
              setCreate(false);
              tokens.reload();
            }}
            submit={async (f) => {
              const result = await request<{
                apiToken: Token & { token: string };
              }>("api-tokens", "POST", {
                label: f.get("name"),
                role: "integration",
              });
              setSecret(result.apiToken.token);
            }}
          >
            <Field label="名称">
              <input className={input} name="name" defaultValue="Bot" required />
            </Field>
          </ActionForm>
        </Modal>
      )}
      {revoke && (
        <Modal title="撤销凭据" close={() => setRevoke(null)}>
          <ActionForm
            label="确认撤销"
            done={() => {
              setRevoke(null);
              tokens.reload();
            }}
            submit={() =>
              request(`api-tokens/${segment(revoke.id)}/revoke`, "POST", {})
            }
          >
            <p>{revoke.label}</p>
          </ActionForm>
        </Modal>
      )}
    </section>
  );
}

function TTLockConnection({
  settings,
  reload,
}: {
  settings: Settings;
  reload: () => void;
}) {
  const { t } = useI18n();
  const request = useStaffApi();
  const [saved, setSaved] = useState(false);
  const connection = settings.ttLockConnection;
  const connected = !!(
    connection?.clientId &&
    connection.clientSecret &&
    (connection.accessToken || connection.appAccount)
  );
  return (
    <details className="rounded-xl border border-ink/10 bg-panel p-5">
      <summary className="cursor-pointer font-semibold">
        {t("TTLock 门锁账号")}
        <span className={`ml-3 text-xs font-normal ${connected ? "text-mint" : "text-ink/50"}`}>
          {t(connected ? "已连接" : "未连接")}
        </span>
      </summary>
      <p className="mt-3 text-sm leading-relaxed text-ink/60">
        {t("设备的「开门密码」能力用这个账号生成临时密码。Client ID 和 Client Secret 来自 TTLock 开放平台上创建的应用。")}
      </p>
      <div className="mt-5">
        <ActionForm
          done={() => {
            setSaved(true);
            reload();
          }}
          submit={async (f) => {
            const current = await request<{ settings: Settings }>("settings");
            return request("settings", "PUT", {
              ...current.settings,
              ttLockConnection: {
                ...current.settings.ttLockConnection,
                baseUrl: f.get("baseUrl"),
                clientId: f.get("clientId"),
                clientSecret: f.get("clientSecret"),
                appAccount: f.get("appAccount"),
                appPwd: f.get("appPwd"),
                accessToken: f.get("accessToken"),
                refreshToken: f.get("refreshToken"),
                accessTokenExpiresAt:
                  current.settings.ttLockConnection?.accessTokenExpiresAt ??
                  null,
              },
            });
          }}
        >
          {(
            [
              ["baseUrl", "服务地址"],
              ["clientId", "Client ID"],
              ["clientSecret", "Client Secret"],
              ["appAccount", "TTLock 账号"],
              ["appPwd", "账号密码（MD5）"],
              ["accessToken", "Access Token"],
              ["refreshToken", "Refresh Token"],
            ] as const
          ).map(([key, label]) => (
            <Field label={label} key={key}>
              <input
                className={input}
                name={key}
                type={
                  [
                    "clientSecret",
                    "appPwd",
                    "accessToken",
                    "refreshToken",
                  ].includes(key)
                    ? "password"
                    : key === "baseUrl"
                      ? "url"
                      : "text"
                }
                autoComplete="off"
                defaultValue={
                  connection?.[key] ??
                  (key === "baseUrl" ? "https://api.ttlock.com" : "")
                }
              />
            </Field>
          ))}
          {saved && (
            <p role="status" className="text-sm text-mint">
              {t("已保存")}
            </p>
          )}
        </ActionForm>
      </div>
    </details>
  );
}
