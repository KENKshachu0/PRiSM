import { useState } from "react";
import { useI18n } from "../../i18n";
import { BillingSettings } from "../BillingPages";
import {
  ActionForm,
  Field,
  Modal,
  State,
  Table,
  button,
  cell,
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
type Token = { id: string; label: string; role: string; status: string };
export function SettingsPage() {
  const { t } = useI18n();
  const { shopCode, canWrite, owner } = useMerchant();
  const request = useStaffApi();
  const settings = useResource<{ settings: Settings }>("settings");
  const gifts = useResource<{
    presents: { id: string; name: string; status: string }[];
  }>("presents");
  const [notice, setNotice] = useState("");
  return (
    <div className="grid gap-5">
      <h2 className="text-xl font-semibold">{t("店铺设置")}</h2>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {owner && <BillingSettings shopCode={shopCode} embedded />}
      {owner && settings.data && (
        <TTLockConnection
          settings={settings.data.settings}
          reload={settings.reload}
        />
      )}
      {!settings.data ? (
        <State error={settings.error} />
      ) : (
        <section className="rounded-xl border border-ink/10 bg-panel p-5">
          <h3 className="mb-4 font-semibold">{t("营业设置")}</h3>
          <ActionForm
            done={() => {
              setNotice(t("已保存"));
              settings.reload();
            }}
            submit={(f) =>
              request("settings", "PUT", {
                ...settings.data!.settings,
                operations: {
                  coinCooldownMs: Number(f.get("cooldown")) * 1000,
                },
                registration: { defaultPresentId: f.get("present") || null },
              })
            }
          >
            <fieldset disabled={!canWrite} className="grid gap-4">
              <Field label="投币冷却时间（秒）">
                <input
                  className={input}
                  type="number"
                  min="0"
                  step="0.1"
                  name="cooldown"
                  defaultValue={
                    settings.data.settings.operations.coinCooldownMs / 1000
                  }
                  required
                />
              </Field>
              <Field label="新玩家礼物">
                <select
                  className={input}
                  name="present"
                  defaultValue={
                    settings.data.settings.registration.defaultPresentId ?? ""
                  }
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
            </fieldset>
          </ActionForm>
        </section>
      )}
      {owner && (
        <>
          <Tokens shopCode={shopCode} />
        </>
      )}
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
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{t("接入凭据")}</h3>
        <button className={button} onClick={() => setCreate(true)}>
          {t("创建凭据")}
        </button>
      </div>
      <div className="grid gap-3 rounded-lg border border-ink/10 bg-surface p-4">
        <div>
          <p className="text-sm font-medium">Koishi / 集成配置</p>
          <p className="mt-1 text-xs text-ink/60">
            将下面的店铺编号和正式 API 地址填入 Bot 配置。
          </p>
        </div>
        <CopyValue label="店铺编号" value={shopCode} />
        <CopyValue label="API 地址" value={window.location.origin} />
      </div>
      {secret && (
        <div role="status" className="rounded border border-ink/15 p-4">
          <p className="mb-2 text-sm">{t("请保存凭据，关闭后不再显示。")}</p>
          <code className="block select-all break-all text-sm">{secret}</code>
          <button className={`${button} mt-3`} onClick={() => setSecret("")}>
            {t("已保存，关闭")}
          </button>
        </div>
      )}
      {tokens.data ? (
        <Table headers={["名称", "用途", "状态", "操作"]}>
          {tokens.data.apiTokens.map((token) => (
            <tr key={token.id}>
              <td className={cell}>{token.label}</td>
              <td className={cell}>
                {token.role === "integration" ? "QQ Bot" : t("机台")}
              </td>
              <td className={cell}>
                {t(token.status === "active" ? "有效" : "已撤销")}
              </td>
              <td className={cell}>
                {token.status === "active" && (
                  <button className={button} onClick={() => setRevoke(token)}>
                    {t("撤销")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <State error={tokens.error} />
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
                role: f.get("role"),
              });
              setSecret(result.apiToken.token);
            }}
          >
            <Field label="名称">
              <input className={input} name="name" required />
            </Field>
            <Field label="用途">
              <select className={input} name="role">
                <option value="integration">QQ Bot</option>
                <option value="machine">{t("机台")}</option>
              </select>
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

function CopyValue({ label, value }: { label: string; value: string }) {
  const copy = async () => {
    await navigator.clipboard?.writeText(value);
  };
  return (
    <div className="grid gap-1">
      <span className="text-xs text-ink/60">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded border border-ink/10 bg-panel px-3 py-2 text-sm">
          {value}
        </code>
        <button className={button} type="button" onClick={copy}>
          复制
        </button>
      </div>
    </div>
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
  return (
    <details className="rounded-xl border border-ink/10 bg-panel p-5">
      <summary className="cursor-pointer font-semibold">
        {t("连接 TTLock 账号")}
      </summary>
      <div className="mt-5">
        <ActionForm
          done={() => {
            setSaved(true);
            reload();
          }}
          submit={(f) =>
            request("settings", "PUT", {
              ...settings,
              ttLockConnection: {
                ...connection,
                baseUrl: f.get("baseUrl"),
                clientId: f.get("clientId"),
                clientSecret: f.get("clientSecret"),
                appAccount: f.get("appAccount"),
                appPwd: f.get("appPwd"),
                accessToken: f.get("accessToken"),
                refreshToken: f.get("refreshToken"),
                accessTokenExpiresAt: connection?.accessTokenExpiresAt ?? null,
              },
            })
          }
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
