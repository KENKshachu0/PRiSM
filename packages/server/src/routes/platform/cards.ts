import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { syncMunetCards } from "./oauth.js";

export const cardsRouter = new Hono<AppBindings>();
const cardInput = z.object({
  label: z.string().trim().min(1).max(40),
  accessCode: z.string().regex(/^\d{20}$/, "卡片号码必须为20位数字"),
});

async function listCards(c: import("hono").Context<AppBindings>, userId: string) {
  const rows = await c.env.DB.prepare(
    "SELECT id,label,card_type AS cardType,access_code AS accessCode,source,disabled_at AS disabledAt,created_at AS createdAt FROM cards WHERE user_id=? ORDER BY created_at DESC",
  ).bind(userId).all();
  return rows.results;
}

cardsRouter.get("/", async (c) => {
  const user = requireUser(c);
  return c.json({ cards: await listCards(c, user.id), authorizationRequired: false, syncError: null });
});

cardsRouter.post("/", async (c) => {
  const user = requireUser(c);
  const body = cardInput.parse(await c.req.json());
  const id = crypto.randomUUID();
  const exists = await c.env.DB.prepare("SELECT id FROM cards WHERE user_id=? AND access_code=?")
    .bind(user.id, body.accessCode).first();
  if (exists) jsonError(409, "这张卡片已经添加过了", "CARD_EXISTS");
  await c.env.DB.prepare(
    "INSERT INTO cards(id,user_id,label,card_type,access_code,source) VALUES (?,?,?,'aime',?,'manual')",
  ).bind(id,user.id,body.label,body.accessCode).run();
  return c.json({ card: { id, label: body.label, cardType: "aime", accessCode: body.accessCode, source: "manual" } }, 201);
});

cardsRouter.delete("/:id", async (c) => {
  const user = requireUser(c);
  await c.env.DB.prepare("DELETE FROM cards WHERE id=? AND user_id=?")
    .bind(c.req.param("id"),user.id).run();
  return c.json({ok:true});
});

cardsRouter.post("/sync", async (c) => {
  const user = requireUser(c);
  let authorizationRequired = false;
  let syncError: string | null = null;
  try {
    const sync = await syncMunetCards(c, user.id);
    authorizationRequired = sync.authorizationRequired;
  } catch (error) {
    console.error(error);
    syncError = "MuNET 暂时无法同步，显示上次结果";
  }
  return c.json({ cards: await listCards(c, user.id), authorizationRequired, syncError });
});
