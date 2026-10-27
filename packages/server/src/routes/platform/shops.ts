import { Hono, type Context } from "hono";
import { z } from "zod";
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { quantizeMoney, resolveLocationTimeZone } from "@prism/core";
import { serializePricingProviderConfig } from "@prism/storage-sql";
import type { AppBindings, AuthUser } from "../../bindings.js";
import { randomToken, sha256, sha256Hex } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { clampShopRadius } from "../../middleware/geo.js";
import { DEFAULT_RESOURCE_GROUP_ID } from "../../resources/billing.js";
import { ensureDefaultGroupStatement } from "../../resources/repository.js";

export type ShopRow = {
  id: string;
  publicId: string;
  name: string;
  timeZone: string;
  heroUrl: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  radius_meters?: number;
  created_by: string;
};

export const billingSetupSchema = z.object({
  paidName: z.string().trim().min(1).max(40),
  freeName: z.string().trim().min(1).max(40),
  hourlyPrice: z
    .number()
    .finite()
    .positive()
    .max(100000)
    .transform(quantizeMoney),
  graceMinutes: z.number().int().min(0).max(59),
  dailyCap: z.number().finite().min(0).max(100000).transform(quantizeMoney),
  botContact: z.string().trim().max(500).default(""),
  autoRegister: z.boolean().default(true),
});

export const createShopSchema = z.object({
  billingSetup: billingSetupSchema
    .extend({ createBotToken: z.boolean().default(false), cashierEnabled: z.boolean().default(false) })
    .optional(),
  name: z
    .string()
    .trim()
    .min(1, "请输入店铺名称")
    .max(80, "店铺名称最多80个字符"),
  heroData: z
    .string()
    .max(700_000, "店铺封面 不能超过 512 KB")
    .regex(
      /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
      "封面只支持 PNG、JPG 或 WebP 图片",
    )
    .nullable()
    .optional(),
  latitude: z.number().gte(-90, "纬度不正确").lte(90, "纬度不正确"),
  longitude: z.number().gte(-180, "经度不正确").lte(180, "经度不正确"),
  radiusMeters: z
    .number()
    .gte(30, "允许距离最小为 30 米")
    .lte(1000, "允许距离最大为 1000 米")
    .default(80),
});

export const patchShopSchema = createShopSchema
  .omit({ billingSetup: true })
  .partial();

export function shopHeroPath(publicId: string, hash: string): string {
  return `/api/v1/shops/${publicId}/hero?v=${hash}`;
}

export function shopTimeZoneStatement(
  db: D1DatabaseLike,
  shopId: string,
  timeZone: string,
  location?: { latitude: number; longitude: number },
) {
  const where = location
    ? "id=? AND latitude=? AND longitude=? AND COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=shops.id AND key='store.profile'),'')!=?"
    : "id=?";
  return db
    .prepare(
      `INSERT INTO app_settings(shop_id,key,value_json,updated_at)
    SELECT id,'store.profile',json_set(
      COALESCE((SELECT value_json FROM app_settings WHERE shop_id=shops.id AND key='store.profile'),'{}'),
      '$.name',name,'$.timeZone',?),?
    FROM shops WHERE ${where}
    ON CONFLICT(shop_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
    )
    .bind(
      timeZone,
      new Date().toISOString(),
      shopId,
      ...(location ? [location.latitude, location.longitude, timeZone] : []),
    );
}

export function billingSetupStatements(
  db: D1DatabaseLike,
  shopId: string,
  setup: z.infer<typeof billingSetupSchema> & { cashierEnabled?: boolean },
) {
  const ruleId = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements = [
    ...([["paid", setup.paidName], ["free", setup.freeName]] as const).map(
      ([code, name]) =>
        db
          .prepare(
            `INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status)
        VALUES (?,'currency',?,?,1,'active') ON CONFLICT(shop_id,type,code) DO NOTHING`,
          )
          .bind(shopId, code, name),
    ),
    db
      .prepare(
        `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
      VALUES (?,?,'time.priority','标准入场',1,'active',?,?,?)`,
      )
      .bind(
        shopId,
        ruleId,
        JSON.stringify(
          serializePricingProviderConfig({
            id: ruleId,
            rules: [
              {
                id: crypto.randomUUID(),
                label: "全天",
                priority: 0,
                timeRange: { start: "00:00", end: "00:00" },
                pricing: {
                  unitMinutes: 60,
                  unitPrice: setup.hourlyPrice,
                  roundGraceMinutes: setup.graceMinutes,
                  priceCap: setup.dailyCap,
                },
              },
            ],
          }),
        ),
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO shop_billing_settings(shop_id,auto_register,bot_contact)
      VALUES (?,?,?) ON CONFLICT(shop_id) DO UPDATE SET auto_register=excluded.auto_register,
      bot_contact=excluded.bot_contact`,
      )
      .bind(shopId, +setup.autoRegister, setup.botContact),
    // The new plan bills the default group, where every resource starts out.
    ensureDefaultGroupStatement(db, shopId, ruleId),
    db
      .prepare(
        `UPDATE resource_groups SET default_pricing_config_id=?,updated_at=? WHERE shop_id=? AND id=?`,
      )
      .bind(ruleId, now, shopId, DEFAULT_RESOURCE_GROUP_ID),
    ...(setup.cashierEnabled ? frontDeskStatements(db, shopId) : []),
  ];
  return { ruleId, statements };
}

/**
 * The front desk as a resource: a check-in there bills like a scan, through the
 * desk's group (the default group, unless moved). It is created once per shop
 * and named in the cashier settings.
 */
/**
 * A shop restored with the front desk on but no desk resource named (a backup
 * from before the desk was a resource) gets one, as migration 0045 gave every
 * such shop.
 */
export function missingFrontDeskStatements<T>(db: { prepare(sql: string): { bind(...values: unknown[]): T } }, shopId: string): T[] {
  const lacksDesk = `EXISTS(SELECT 1 FROM app_settings WHERE shop_id=? AND key='cashier.settings'
    AND json_extract(value_json,'$.enabled') AND json_extract(value_json,'$.resourceId') IS NULL)`;
  return [
    db.prepare(
      `INSERT INTO machines(id,public_id,shop_id,name,enabled,kind,aliases_json,hinata_url_encrypted)
       SELECT ?,lower(hex(randomblob(6))),?,'前台',1,'machine','[]','' WHERE ${lacksDesk}
       ON CONFLICT(id) DO NOTHING`,
    ).bind(`desk-${shopId}`, shopId, shopId),
    db.prepare(
      `UPDATE app_settings SET value_json=json_set(value_json,'$.resourceId',?)
       WHERE shop_id=? AND key='cashier.settings' AND json_extract(value_json,'$.enabled')
       AND json_extract(value_json,'$.resourceId') IS NULL
       AND EXISTS(SELECT 1 FROM machines WHERE id=? AND shop_id=?)`,
    ).bind(`desk-${shopId}`, shopId, `desk-${shopId}`, shopId),
  ];
}

export function frontDeskStatements(db: D1DatabaseLike, shopId: string) {
  const deskId = `desk-${shopId}`;
  const now = new Date().toISOString();
  return [
    db.prepare(
      `INSERT INTO machines(id,public_id,shop_id,name,enabled,kind,aliases_json,hinata_url_encrypted)
       VALUES (?,?,?,'前台',1,'machine','[]','') ON CONFLICT(id) DO NOTHING`,
    ).bind(deskId, randomToken(12), shopId),
    db.prepare(
      `INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,'cashier.settings',?,?)
       ON CONFLICT(shop_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
    ).bind(shopId, JSON.stringify({ enabled: true, resourceId: deskId }), now),
  ];
}

export async function canAccessShop(
  c: Context<AppBindings>,
  user: AuthUser,
  shopId: string,
): Promise<boolean> {
  if (user.role === "admin") return true;
  const row = await c.env.DB.prepare(
    "SELECT id FROM shop_members WHERE shop_id = ? AND user_id = ?",
  )
    .bind(shopId, user.id)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function listShopsForUser(
  c: Context<AppBindings>,
  user: AuthUser,
): Promise<ShopRow[]> {
  if (user.role === "admin") {
    return (
      await c.env.DB.prepare(
        "SELECT id, public_id AS publicId, name, COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=shops.id AND key='store.profile'),'Asia/Shanghai') AS timeZone, CASE WHEN hero_data IS NULL OR hero_data = '' THEN NULL ELSE '/api/v1/shops/' || public_id || '/hero?v=' || COALESCE(hero_hash, 'original') END AS heroUrl, latitude, longitude, radius_meters AS radiusMeters, radius_meters, created_by FROM shops ORDER BY created_at DESC",
      )
        .bind()
        .all<ShopRow>()
    ).results;
  }
  return (
    await c.env.DB.prepare(
      `SELECT shops.id, shops.public_id AS publicId, shops.name,
              COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=shops.id AND key='store.profile'),'Asia/Shanghai') AS timeZone,
              CASE WHEN shops.hero_data IS NULL OR shops.hero_data = '' THEN NULL ELSE '/api/v1/shops/' || shops.public_id || '/hero?v=' || COALESCE(shops.hero_hash, 'original') END AS heroUrl,
              shops.latitude, shops.longitude,
              shops.radius_meters AS radiusMeters, shops.radius_meters, shops.created_by
       FROM shops
       JOIN shop_members ON shop_members.shop_id = shops.id
       WHERE shop_members.user_id = ?
       ORDER BY shops.created_at DESC`,
    )
      .bind(user.id)
      .all<ShopRow>()
  ).results;
}

export const shopsRouter = new Hono<AppBindings>();

// List shops for the authenticated user / admin
shopsRouter.get("/", async (c) => {
  const user = requireUser(c);
  return c.json({ shops: await listShopsForUser(c, user) });
});

// Create new shop
shopsRouter.post("/", async (c) => {
  const user = requireUser(c);
  const body = createShopSchema.parse(await c.req.json());
  const timeZone = resolveLocationTimeZone(body.latitude, body.longitude);
  const shopId = crypto.randomUUID();
  const publicId = randomToken(8);
  const heroHash = body.heroData ? await sha256(body.heroData) : null;
  const setup = body.billingSetup;
  const botToken = setup?.createBotToken
    ? `prism_integration_${randomToken(32)}`
    : null;
  const now = new Date().toISOString();

  const statements = [
    c.env.DB.prepare(
      "INSERT INTO shops (id, public_id, name, hero_data, hero_hash, latitude, longitude, radius_meters, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      shopId,
      publicId,
      body.name,
      body.heroData ?? null,
      heroHash,
      body.latitude,
      body.longitude,
      clampShopRadius(body.radiusMeters),
      user.id,
    ),
    c.env.DB.prepare(
      "INSERT INTO shop_members (id, shop_id, user_id, role) VALUES (?, ?, ?, 'owner')",
    ).bind(crypto.randomUUID(), shopId, user.id),
  ];

  statements.push(shopTimeZoneStatement(c.env.DB, shopId, timeZone));

  if (setup) {
    statements.push(
      ...billingSetupStatements(c.env.DB, shopId, setup).statements,
    );
  } else {
    // New shops require a bound platform identity and let a first binding create
    // the player; a shop that never had settings would otherwise refuse newcomers.
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO shop_billing_settings(shop_id,auto_register,identity_binding_required) VALUES (?,1,1)",
      ).bind(shopId),
      // Every resource starts in the default group; without a plan it is free.
      ensureDefaultGroupStatement(c.env.DB, shopId),
    );
  }
  if (setup) {
    if (botToken) {
      const tokenId = crypto.randomUUID();
      // The bot is a resource from the start, in the default group, so the shop
      // sees it before it ever connects and its credential has one resource.
      const botId = crypto.randomUUID();
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES (?,?,'Bot','integration','prism_integration',?,'active',?)",
        ).bind(shopId, tokenId, await sha256Hex(botToken), now),
        c.env.DB.prepare(
          `INSERT INTO machines(id,public_id,shop_id,name,enabled,kind,aliases_json,hinata_url_encrypted)
           VALUES (?,?,?,'Bot',1,'machine','[]','')`,
        ).bind(botId, randomToken(12), shopId),
        c.env.DB.prepare(
          `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
           VALUES (?,?,'bot',?,'{}',?,?)`,
        ).bind(shopId, botId, JSON.stringify({ tokenId }), now, now),
      );
    }
  }

  await c.env.DB.batch(statements);
  const { heroData, billingSetup, ...shop } = body;
  return c.json(
    {
      botToken,
      shop: {
        id: shopId,
        publicId,
        ...shop,
        timeZone,
        heroUrl: heroHash ? shopHeroPath(publicId, heroHash) : null,
      },
    },
    201,
  );
});

// Shop details by id or publicId
shopsRouter.get("/:id", async (c) => {
  const idOrPublicId = c.req.param("id");
  const shop = await c.env.DB.prepare(
    `SELECT id, public_id AS publicId, name,
            COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=shops.id AND key='store.profile'),'Asia/Shanghai') AS timeZone,
            CASE WHEN hero_data IS NULL OR hero_data = '' THEN NULL ELSE '/api/v1/shops/' || public_id || '/hero?v=' || COALESCE(hero_hash, 'original') END AS heroUrl,
            latitude, longitude, radius_meters AS radiusMeters, radius_meters, created_at AS createdAt, updated_at AS updatedAt, created_by AS createdBy
     FROM shops
     WHERE id = ? OR public_id = ?`,
  )
    .bind(idOrPublicId, idOrPublicId)
    .first<ShopRow>();

  if (!shop) {
    jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  }

  return c.json({ shop });
});

// Shop cover art
shopsRouter.get("/:publicId/hero", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT hero_data AS heroData, COALESCE(hero_hash, 'original') AS version FROM shops WHERE public_id = ?",
  )
    .bind(c.req.param("publicId"))
    .first<{ heroData: string | null; version: string }>();

  const version = c.req.query("v");
  const missing = () =>
    new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    });

  if (!row || (version !== undefined && version !== row.version)) {
    return missing();
  }

  const match = row?.heroData?.match(
    /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!match) return missing();

  const mimeType = match[1];
  const encoded = match[2];
  if (!mimeType || !encoded) return missing();

  const headers = {
    "cache-control": version
      ? "public, max-age=31536000, immutable"
      : "public, max-age=60, must-revalidate",
    "content-type": mimeType,
    etag: `"${row.version}"`,
  };

  const validators = c.req
    .header("if-none-match")
    ?.split(",")
    .map((value) => value.trim().replace(/^W\//, ""));

  if (validators?.some((value) => value === "*" || value === headers.etag)) {
    return new Response(null, { status: 304, headers });
  }

  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new Response(bytes, { headers });
});

// Update shop details
shopsRouter.patch("/:id", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.param("id");

  if (!(await canAccessShop(c, user, shopId))) {
    jsonError(403, "你没有这个店铺的管理权限", "FORBIDDEN");
  }

  if (user.role !== "admin") {
    const member = await c.env.DB.prepare(
      "SELECT role FROM shop_members WHERE shop_id = ? AND user_id = ?",
    )
      .bind(shopId, user.id)
      .first<{ role: string }>();
    if (!member || member.role !== "owner") {
      jsonError(403, "只有店铺负责人或管理员才能修改店铺信息", "FORBIDDEN");
    }
  }

  const body = patchShopSchema.parse(await c.req.json());
  const location = await c.env.DB.prepare(
    "SELECT latitude, longitude FROM shops WHERE id = ?",
  )
    .bind(shopId)
    .first<{ latitude: number; longitude: number }>();

  if (!location) {
    jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  }

  const latitude = body.latitude ?? location.latitude;
  const longitude = body.longitude ?? location.longitude;
  const timeZone = resolveLocationTimeZone(latitude, longitude);
  const radius =
    body.radiusMeters !== undefined
      ? clampShopRadius(body.radiusMeters)
      : null;

  const statements = [
    c.env.DB.prepare(
      `UPDATE shops
       SET name = COALESCE(?, name),
           hero_data = CASE WHEN ? THEN ? ELSE hero_data END,
           hero_hash = CASE WHEN ? THEN ? ELSE hero_hash END,
           latitude = COALESCE(?, latitude),
           longitude = COALESCE(?, longitude),
           radius_meters = COALESCE(?, radius_meters),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).bind(
      body.name ?? null,
      body.heroData !== undefined ? 1 : 0,
      body.heroData ?? null,
      body.heroData !== undefined ? 1 : 0,
      body.heroData ? await sha256(body.heroData) : null,
      latitude,
      longitude,
      radius,
      shopId,
    ),
    shopTimeZoneStatement(c.env.DB, shopId, timeZone),
  ];

  await c.env.DB.batch(statements);

  const updated = await c.env.DB.prepare(
    "SELECT id, public_id AS publicId, name, COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=shops.id AND key='store.profile'),'Asia/Shanghai') AS timeZone, CASE WHEN hero_data IS NULL OR hero_data = '' THEN NULL ELSE '/api/v1/shops/' || public_id || '/hero?v=' || COALESCE(hero_hash, 'original') END AS heroUrl, latitude, longitude, radius_meters AS radiusMeters, radius_meters, created_at AS createdAt, updated_at AS updatedAt FROM shops WHERE id = ?",
  )
    .bind(shopId)
    .first<ShopRow>();

  return c.json({ shop: updated });
});

// Delete shop
shopsRouter.delete("/:id", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.param("id");
  const shop = await c.env.DB.prepare("SELECT id FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ id: string }>();

  if (!shop) {
    jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  }

  if (user.role !== "admin") {
    const member = await c.env.DB.prepare(
      "SELECT role FROM shop_members WHERE shop_id = ? AND user_id = ?",
    )
      .bind(shopId, user.id)
      .first<{ role: string }>();
    if (!member || member.role !== "owner") {
      jsonError(403, "只有店铺负责人或管理员才能删除店铺", "FORBIDDEN");
    }
  }

  const used = await c.env.DB.prepare(
    "SELECT 1 FROM players WHERE shop_id=? UNION ALL SELECT 1 FROM player_operations WHERE shop_id=? UNION ALL SELECT 1 FROM machine_login_events e JOIN machines m ON m.id=e.machine_id WHERE m.shop_id=? LIMIT 1",
  )
    .bind(shopId, shopId, shopId)
    .first();

  if (used) {
    jsonError(409, "店铺已有业务记录，不能删除", "SHOP_HAS_HISTORY");
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM platform_binding_codes WHERE shop_id=?",
    ).bind(shopId),
    c.env.DB.prepare(
      "DELETE FROM shop_billing_settings WHERE shop_id=?",
    ).bind(shopId),
    c.env.DB.prepare(
      "DELETE FROM shop_staff_accounts WHERE shop_id=?",
    ).bind(shopId),
    c.env.DB.prepare(
      "DELETE FROM machine_tickets WHERE machine_id IN (SELECT id FROM machines WHERE shop_id=?)",
    ).bind(shopId),
    c.env.DB.prepare("DELETE FROM machines WHERE shop_id = ?").bind(shopId),
    c.env.DB.prepare("DELETE FROM resource_groups WHERE shop_id = ?").bind(shopId),
    c.env.DB.prepare("DELETE FROM shop_members WHERE shop_id = ?").bind(shopId),
    c.env.DB.prepare("DELETE FROM app_settings WHERE shop_id = ?").bind(shopId),
    c.env.DB.prepare("DELETE FROM api_tokens WHERE shop_id = ?").bind(shopId),
    c.env.DB.prepare("DELETE FROM pricing_configs WHERE shop_id = ?").bind(shopId),
    c.env.DB.prepare("DELETE FROM asset_definitions WHERE shop_id = ?").bind(shopId),
    c.env.DB.prepare("DELETE FROM shops WHERE id = ?").bind(shopId),
  ]);

  return c.json({ ok: true });
});
