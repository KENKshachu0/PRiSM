/** Home Assistant helpers for the end-to-end scripts: sign in, and its WebSocket command API. */

const json = { "content-type": "application/json" };

async function exchange(base: string, clientId: string, form: Record<string, string>): Promise<string> {
  const response = await fetch(`${base}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, ...form }),
  });
  if (!response.ok) throw new Error(`/auth/token ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** An access token for a user, through Home Assistant's own login flow. */
export async function haLogin(base: string, username: string, password: string): Promise<string> {
  const clientId = `${base}/`;
  const flow = (await (await fetch(`${base}/auth/login_flow`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ client_id: clientId, handler: ["homeassistant", null], redirect_uri: clientId }),
  })).json()) as { flow_id: string };
  const result = (await (await fetch(`${base}/auth/login_flow/${flow.flow_id}`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ client_id: clientId, username, password }),
  })).json()) as { result?: string };
  if (!result.result) throw new Error(`login failed for ${username}: ${JSON.stringify(result)}`);
  return exchange(base, clientId, { grant_type: "authorization_code", code: result.result });
}

/** Run commands over the WebSocket API as the user the token belongs to; one result per command. */
export function haCommands(base: string, accessToken: string, commands: Array<Record<string, unknown>>): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/websocket`);
    const results: unknown[] = [];
    const timer = setTimeout(() => reject(new Error("home assistant websocket timed out")), 20_000);
    const send = () => ws.send(JSON.stringify({ id: results.length + 1, ...commands[results.length]! }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; success?: boolean; result?: unknown; error?: unknown };
      if (message.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: accessToken }));
      else if (message.type === "auth_ok") send();
      else if (message.type === "auth_invalid") reject(new Error("auth_invalid"));
      else if (message.type === "result") {
        if (!message.success) {
          clearTimeout(timer);
          ws.close();
          return reject(new Error(`command failed: ${JSON.stringify(message.error)}`));
        }
        results.push(message.result);
        if (results.length === commands.length) {
          clearTimeout(timer);
          ws.close();
          resolve(results);
        } else send();
      }
    };
    ws.onerror = () => reject(new Error("home assistant websocket error"));
  });
}

/** A long-lived access token for the user the access token belongs to. */
export async function haLongLivedToken(base: string, accessToken: string, name: string): Promise<string> {
  const [token] = await haCommands(base, accessToken, [
    { type: "auth/long_lived_access_token", client_name: `${name}-${Date.now()}`, lifespan: 30 },
  ]);
  return String(token);
}

/** A user who is not an administrator, with a long-lived token: what a shop that hands over a limited token has. */
export async function haStaffToken(base: string, adminAccessToken: string, username: string, password: string): Promise<string> {
  const [created] = (await haCommands(base, adminAccessToken, [
    { type: "config/auth/create", name: "Staff", group_ids: ["system-users"] },
  ])) as [{ user: { id: string } }];
  await haCommands(base, adminAccessToken, [
    { type: "config/auth_provider/homeassistant/create", user_id: created.user.id, username, password },
  ]);
  return haLongLivedToken(base, await haLogin(base, username, password), "staff");
}

export async function haStates(base: string, token: string): Promise<Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>> {
  return (await (await fetch(`${base}/api/states`, { headers: { authorization: `Bearer ${token}` } })).json()) as never;
}

/** Call a Home Assistant service, as a person at the switch would. */
export async function haService(base: string, token: string, domain: string, service: string, data: Record<string, unknown>) {
  const response = await fetch(`${base}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: { ...json, authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`${domain}.${service} ${response.status}: ${await response.text()}`);
}
