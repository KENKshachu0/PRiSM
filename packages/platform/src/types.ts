export type Env = Cloudflare.Env & {
  APP_ORIGIN: string;
  SESSION_SECRET: string;
  URL_ENCRYPTION_KEY: string;
  MUNET_CLIENT_ID: string;
  MUNET_CLIENT_SECRET: string;
  APPLE_TEAM_ID: string;
  EXTRA_ALLOWED_ORIGINS?: string;
  ANDROID_CERT_FINGERPRINTS?: string;
};

export type Variables = {
  user: AuthUser | null;
  sessionId: string | null;
};

export type AppBindings = {
  Bindings: Env;
  Variables: Variables;
};

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: "user" | "admin";
  bannedAt: string | null;
};

export type ShopRow = {
  id: string;
  publicId: string;
  name: string;
  heroUrl: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  created_by: string;
};

export type MachineRow = {
  id: string;
  public_id: string;
  shop_id: string;
  shop_public_id: string;
  name: string;
  aliases_json: string;
  kind: "machine" | "door";
  ha_binding_encrypted: string | null;
  ttlock_lock_id: number | null;
  mahjong_config_json: string | null;
  coin_key: number;
  coin_after_swipe: number;
  hinata_url_encrypted: string;
  hinata_password_encrypted: string | null;
  enabled: number;
  shop_name: string;
  machine_geo: number;
  billing_enabled: number;
  shop_hero_url: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
};
