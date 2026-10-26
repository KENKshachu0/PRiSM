/**
 * A player's cards at one shop.
 *
 * A card number works like a password on the games, so the shop never holds
 * it in the clear. Each binding keeps a keyed hash of the card, which is how a
 * card a machine reports is recognised, and the card encrypted, which is how
 * the platform sends it to a machine for the player. Both use the platform's
 * key, so neither the shop's data nor its backups map a card to a player.
 *
 * A card is bound when its player swipes it through one of the shop's QR pages
 * or adds it at one of the shop's readers. A player may have several cards; a
 * card belongs to at most one player per shop.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { decryptSecret, encryptSecret, toBase64Url } from "../crypto.js";

/** A card as a reader reported it: its type and the number games log in with. */
export type ReportedCard = { type: string; accessCode: string };

/**
 * The card in an IO card snapshot (`{ source, card: { type, ... } }`), or null
 * when it carries no number a game logs in with (a bare FeliCa, an empty slot).
 */
export function reportedCard(snapshot: unknown): ReportedCard | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const card = (snapshot as { card?: unknown }).card;
  if (!card || typeof card !== "object") return null;
  const { type, accessCode, cardNumber } = card as { type?: unknown; accessCode?: unknown; cardNumber?: unknown };
  if (typeof type !== "string") return null;
  const value = typeof accessCode === "string" && accessCode ? accessCode : typeof cardNumber === "string" ? cardNumber : "";
  return /^\d{20}$/.test(value) ? { type, accessCode: value } : null;
}

/** An IO card snapshot without its numbers: what may be kept in the device log. */
export function withoutCardNumber(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const { card, ...rest } = snapshot as { card?: unknown };
  const type = card && typeof card === "object" ? (card as { type?: unknown }).type : undefined;
  return { ...rest, ...(typeof type === "string" ? { type } : {}) };
}

const encoder = new TextEncoder();

async function hashOf(key: string, shopId: string, accessCode: string): Promise<string> {
  const hmac = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`prism.card.v1:${key}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(await crypto.subtle.sign("HMAC", hmac, encoder.encode(`${shopId}:${accessCode}`)));
}

export type CardStore = {
  /** The player a card belongs to at this shop, or null. */
  playerOf(accessCode: string): Promise<string | null>;
  /** The card hash a reported card has here, to tell unknown cards apart without keeping them. */
  hashOf(accessCode: string): Promise<string>;
  /**
   * Bind a card to a player. `taken` when it belongs to another player here;
   * a card already theirs is marked used.
   */
  bind(input: { playerId: string; card: ReportedCard; source: "scan" | "reader" }): Promise<"bound" | "exists" | "taken">;
  /** The card most recently used by a player here, decrypted, for sending to a machine. */
  latestOf(playerId: string): Promise<string | null>;
  /** How many cards a player has here, and when each was bound and last used. Never the numbers. */
  listOf(playerId: string): Promise<Array<{ id: string; type: string; source: string; createdAt: string; lastUsedAt: string | null }>>;
  remove(playerId: string, cardId: string): Promise<boolean>;
};

export function createCardStore(db: D1DatabaseLike, shopId: string, key: string | undefined): CardStore {
  const requireKey = () => {
    if (!key) throw new Error("URL_ENCRYPTION_KEY is required to keep cards.");
    return key;
  };

  /**
   * A card identity from before cards were encrypted (`player_identities`,
   * provider `aime`) is moved into the encrypted store the first time it is
   * needed, and the plaintext row removed.
   */
  async function adoptLegacy(where: { accessCode: string } | { playerId: string }): Promise<{ playerId: string; accessCode: string } | null> {
    const row = "accessCode" in where
      ? await db.prepare("SELECT player_id, subject FROM player_identities WHERE shop_id = ? AND provider = 'aime' AND subject = ?")
          .bind(shopId, where.accessCode).first<{ player_id: string; subject: string }>()
      : await db.prepare("SELECT player_id, subject FROM player_identities WHERE shop_id = ? AND provider = 'aime' AND player_id = ? ORDER BY created_at LIMIT 1")
          .bind(shopId, where.playerId).first<{ player_id: string; subject: string }>();
    if (!row || !/^\d{20}$/.test(row.subject)) return null;
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(
        `INSERT INTO player_cards(shop_id, id, player_id, card_hash, card_encrypted, card_type, source, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, 'aime', 'legacy', ?, NULL) ON CONFLICT(shop_id, card_hash) DO NOTHING`,
      ).bind(shopId, crypto.randomUUID(), row.player_id, await hashOf(requireKey(), shopId, row.subject),
        await encryptSecret(row.subject, requireKey()), now),
      db.prepare("DELETE FROM player_identities WHERE shop_id = ? AND provider = 'aime' AND subject = ?").bind(shopId, row.subject),
    ]);
    return { playerId: row.player_id, accessCode: row.subject };
  }

  return {
    async playerOf(accessCode) {
      if (!key) return null;
      const row = await db.prepare("SELECT player_id FROM player_cards WHERE shop_id = ? AND card_hash = ?")
        .bind(shopId, await hashOf(key, shopId, accessCode)).first<{ player_id: string }>();
      return row?.player_id ?? (await adoptLegacy({ accessCode }))?.playerId ?? null;
    },

    hashOf: (accessCode) => hashOf(requireKey(), shopId, accessCode),

    async bind(input) {
      const secret = requireKey();
      const hash = await hashOf(secret, shopId, input.card.accessCode);
      const now = new Date().toISOString();
      const owner = (await db.prepare("SELECT id, player_id FROM player_cards WHERE shop_id = ? AND card_hash = ?")
        .bind(shopId, hash).first<{ id: string; player_id: string }>())
        ?? await adoptLegacy({ accessCode: input.card.accessCode }).then((adopted) => adopted ? { id: "", player_id: adopted.playerId } : null);
      if (owner && owner.player_id !== input.playerId) return "taken";
      if (owner) {
        await db.prepare("UPDATE player_cards SET last_used_at = ? WHERE shop_id = ? AND card_hash = ?").bind(now, shopId, hash).run();
        return "exists";
      }
      await db.prepare(
        `INSERT INTO player_cards(shop_id, id, player_id, card_hash, card_encrypted, card_type, source, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(shop_id, card_hash) DO NOTHING`,
      ).bind(shopId, crypto.randomUUID(), input.playerId, hash, await encryptSecret(input.card.accessCode, secret),
        input.card.type, input.source, now, now).run();
      return "bound";
    },

    async latestOf(playerId) {
      if (!key) return null;
      const row = await db.prepare(
        `SELECT card_encrypted FROM player_cards WHERE shop_id = ? AND player_id = ?
         ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1`,
      ).bind(shopId, playerId).first<{ card_encrypted: string }>();
      if (row) return decryptSecret(row.card_encrypted, key);
      return (await adoptLegacy({ playerId }))?.accessCode ?? null;
    },

    async listOf(playerId) {
      const rows = await db.prepare(
        `SELECT id, card_type, source, created_at, last_used_at FROM player_cards
         WHERE shop_id = ? AND player_id = ? ORDER BY created_at`,
      ).bind(shopId, playerId).all<{ id: string; card_type: string; source: string; created_at: string; last_used_at: string | null }>();
      return rows.results.map((row) => ({
        id: row.id, type: row.card_type, source: row.source, createdAt: row.created_at, lastUsedAt: row.last_used_at,
      }));
    },

    async remove(playerId, cardId) {
      const result = await db.prepare("DELETE FROM player_cards WHERE shop_id = ? AND player_id = ? AND id = ?")
        .bind(shopId, playerId, cardId).run() as { meta?: { changes?: number } };
      return (result.meta?.changes ?? 0) > 0;
    },
  };
}
