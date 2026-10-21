export type Effect = {
  id: string;
  name: string;
  type: string;
  scope: string;
  value: number | null;
  consumable: boolean;
  limitPerDay: number | null;
  activeAt?: string | null;
  expiresAt?: string | null;
  status: string;
  config: Record<string, unknown> | null;
};

export type Grant = {
  assetType: string;
  assetCode: string;
  amount: number;
  mergeStrategy: string;
  activeAt: string | null;
  expiresAt: string | null;
  durationMs?: number;
  maxPerPlayer?: number;
};

export type Present = {
  id: string;
  name: string;
  status: string;
  oncePerPlayer: boolean;
  activeAt?: string | null;
  expiresAt?: string | null;
  grants: Grant[];
};

export type RedeemCode = {
  id: string;
  code: string;
  presentId: string;
  usageCount: number;
  maxUseCount: number;
  activeAt?: string | null;
  expiresAt: string | null;
  redemptions?: {
    playerId: string;
    playerDisplayName: string;
    redeemedAt: string;
  }[];
};
