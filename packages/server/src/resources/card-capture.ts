/**
 * Adding a card at a shop's reader.
 *
 * A player opens a short window on a cabinet's page, then puts their card on
 * that cabinet's reader. The first card the reader reports in the window, other
 * than one the platform itself sent, is added to the player's PRiSM account
 * and bound to them at the shop. Only a cabinet connected directly (whose IO
 * reports cards back) can do this.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { createCardStore, type ReportedCard } from "./cards.js";

/** How long a reader waits for the card. */
export const CARD_CAPTURE_MS = 60_000;

export type CardCapture = {
  id: string;
  shopId: string;
  userId: string;
  playerId: string;
  expiresAt: number;
  result?: CardCaptureResult;
};

/**
 * `added`: new to the account and bound here. `bound`: already on the account,
 * now bound here. `exists`: already bound to this player here. `taken`: bound to
 * another player here; nothing changes. `unsupported`: a card without a number
 * games log in with.
 */
export type CardCaptureResult = { status: "added" | "bound" | "exists" | "taken" | "unsupported"; cardType?: string };

export async function bindReaderCard(
  db: D1DatabaseLike,
  key: string | undefined,
  capture: CardCapture,
  card: ReportedCard | null,
): Promise<CardCaptureResult> {
  if (!card) return { status: "unsupported" };
  const cards = createCardStore(db, capture.shopId, key);
  const bound = await cards.bind({ playerId: capture.playerId, card, source: "reader" });
  if (bound === "taken") return { status: "taken", cardType: card.type };
  const account = await db.prepare("SELECT id FROM cards WHERE user_id = ? AND access_code = ?")
    .bind(capture.userId, card.accessCode).first<{ id: string }>();
  if (!account) {
    await db.prepare(
      "INSERT INTO cards(id, user_id, label, card_type, access_code, source) VALUES (?, ?, ?, ?, ?, 'reader')",
    ).bind(crypto.randomUUID(), capture.userId, "读卡器添加", card.type, card.accessCode).run();
  }
  return { status: account ? (bound === "exists" ? "exists" : "bound") : "added", cardType: card.type };
}
