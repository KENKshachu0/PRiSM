import { z } from "zod";
import { normalizeHinataUrl } from "./hinata";

export const accessCodeSchema = z
  .string()
  .regex(/^[0-24-9]\d{19}$/, "卡片号码必须为20位数字且不能以3开头");

export const createCardSchema = z.object({
  label: z.string().trim().min(1).max(40),
  accessCode: accessCodeSchema,
});

export const billingSetupSchema = z.object({
  paidName: z.string().trim().min(1).max(40),
  freeName: z.string().trim().min(1).max(40),
  hourlyPrice: z.number().finite().positive().max(100000),
  graceMinutes: z.number().int().min(0).max(59),
  dailyCap: z.number().finite().min(0).max(100000),
  botContact: z.string().trim().max(160).default(""),
  autoRegister: z.boolean(),
});
export const createShopSchema = z.object({
  billingSetup: billingSetupSchema.optional(),
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

const connectionUrl = z
  .string()
  .trim()
  .url()
  .refine(
    (value) => ["https:", "http:"].includes(new URL(value).protocol),
    "请填写 HTTP 或 HTTPS 地址",
  );
export const createMachineSchema = z.object({
  kind: z.enum(["machine", "door"]).default("machine"),
  homeAssistant: z
    .object({
      url: connectionUrl,
      entityId: z
        .string()
        .regex(/^(switch|input_boolean)\.[a-z0-9_]+$/, "请选择电源开关实体"),
      token: z.string().trim().max(4096).optional(),
    })
    .nullable()
    .optional(),
  ttlockLockId: z.number().int().positive().nullable().optional(),
  coinKey: z.number().int().min(0).max(65535).default(32),
  coinAfterSwipe: z.boolean().default(false),
  mahjong: z.object({ capacity: z.number().int().min(2).max(8), pricingConfigIds: z.array(z.string().min(1)).max(20) }).nullable().optional(),
  shopId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  aliases: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  hinataUrl: z
    .string()
    .trim()
    .transform(normalizeHinataUrl)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    }, "请填写正确的机台连接地址")
    .nullable()
    .optional(),
  hinataPassword: z.string().trim().max(128).optional().nullable(),
  enabled: z.boolean().default(true),
});

export const patchMachineSchema = createMachineSchema.partial();

export const machineLoginSchema = z.object({
  cardId: z.string().min(1, "请选择卡片"),
  lat: z.number().gte(-90).lte(90).optional(),
  lng: z.number().gte(-180).lte(180).optional(),
  accuracy: z.number().min(0).max(10_000).optional(),
  ticket: z.string({ required_error: "缺少会话凭证" }).min(1, "缺少会话凭证"),
  clientTimestamp: z.string().optional(),
});

export const machineSessionStartSchema = z.object({
  shopCode: z.string().trim().min(1, "缺少店铺编号").max(32, "店铺编号无效"),
  publicId: z.string().trim().min(1, "缺少机台编号").max(80, "机台编号无效"),
});

export const appClipAuthExchangeSchema = z.object({
  code: z.string().trim().min(1, "缺少授权码").max(160, "授权码无效"),
});

export const setUserRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["user", "admin"]),
});

export const passkeyLabelSchema = z.string().trim().min(1).max(60);

export const passkeyNameSchema = z.object({
  name: passkeyLabelSchema,
});

export const shopMemberSchema = z.object({
  shopId: z.string().min(1),
  user: z.string().trim().min(1).max(80),
  role: z.enum(["owner", "staff"]).default("staff"),
});

export const createBanSchema = z.object({
  subjectType: z.enum(["user", "ip", "card", "machine"]),
  subjectValue: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime().optional(),
});
