import type {
  AssetHoldingUnavailableReason,
  Cents,
  BillTimeline,
  DeviceCommand,
  DeviceCommandType,
  DeviceState,
  MachineConnection,
} from "@prism/core";

export type PlayerSummary = {
  player: {
    id: string;
    displayName: string;
    status: "active" | "disabled" | "banned";
  };
  wallet: Array<{
    assetCode: string;
    quantity: Cents;
  }>;
  activeSession: {
    id: string;
    startedAt: Date;
  } | null;
};

export type PlayerAssetHoldingListItem = {
  id: string;
  assetType: string;
  assetCode: string;
  assetName: string | null;
  quantity: number;
  activeAt: Date | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
  availability?: "available" | "unavailable";
  unavailableReasons?: AssetHoldingUnavailableReason[];
};

export type PlayerAssetLedgerListItem = {
  id: string;
  assetType: string;
  assetCode: string;
  assetName: string;
  delta: number;
  reason: string;
  refId: string;
  transactionId: string | null;
  createdAt: Date;
};

export type PlayerAssets = {
  holdings: PlayerAssetHoldingListItem[];
  ledgerEntries: PlayerAssetLedgerListItem[];
};

export type SessionHistoryListItem = {
  sessionId: string;
  startedAt: Date;
  endedAt: Date | null;
  durationMinutes: number | null;
  subtotal: Cents | null;
  total: Cents | null;
  status: "active" | "closed" | "settled";
  settledAt: Date | null;
};

export type SessionHistoryDetail = SessionHistoryListItem & {
  chargeItems: Array<{
    id: string;
    source: string;
    label: string;
    amount: Cents;
  }>;
  adjustments: Array<{
    id: string;
    source: string;
    label: string;
    amount: Cents;
  }>;
};

export type StaffRedeemCodeRedemptionListItem = {
  codeId: string;
  playerId: string;
  playerDisplayName: string;
  redeemedAt: Date;
};

export type PlayerRedeemRecordListItem = {
  codeId: string;
  code: string;
  presentId: string;
  presentName: string;
  redeemedAt: Date;
};

export type CheckoutHistoryRecord = {
  id: string; total: number; settledAt: string; startedAt: string | null; endedAt: string | null; sessionCount: number;
};
export type PlayerCheckoutReceipt = {
  externalPayment?: { method: string; staffId: string; collectedAt: string };
  settlements?: Array<{ settlement: { sessionId: string; startedAt: string; endedAt: string | null } }>;
  playerSettlement: { total: number; settledAt: string };
  timeline: BillTimeline;
  wallet?: { balanceAfter: number } | null;
  chargeItems: { id: string; label: string; amount: number }[];
  adjustments: { id: string; label: string; amount: number }[];
};
export type PlayerQueries = {
  listPlayerCheckouts?(playerId: string, offset: number): Promise<{ records: CheckoutHistoryRecord[]; nextOffset: number | null }>;
  getPlayerCheckout?(playerId: string, checkoutId: string): Promise<PlayerCheckoutReceipt | null>;
  getLatestPlayerCheckout?(playerId: string): Promise<PlayerCheckoutReceipt | null>;
  getPlayerSummary(playerId: string): Promise<PlayerSummary>;
  listPlayerAssets?(playerId: string): Promise<PlayerAssets>;
  listPlayerSessionHistory?(playerId: string): Promise<SessionHistoryListItem[]>;
  getPlayerSessionHistoryDetail?(playerId: string, sessionId: string): Promise<SessionHistoryDetail | null>;
};

export type StaffPlayerListItem = {
  paymentMode?: "cashier";
  id: string;
  displayName: string;
  status: "active" | "disabled" | "banned";
  walletTotal: Cents;
  activeSessionId: string | null;
  hasUnpaidSession?: boolean;
  identities?: Array<{
    provider: string;
    subject: string;
    createdAt: Date;
  }>;
};

export type StaffActiveSessionListItem = {
  id: string;
  playerId: string;
  playerDisplayName: string;
  startedAt: Date;
  endedAt?: Date | null;
  elapsedMinutes: number;
  label?: string | null;
  /** The plan the session bills; null for the unpriced placeholder session. */
  pricingConfigId?: string | null;
  status?: "active" | "closed";
  identities?: Array<{
    provider: string;
    subject: string;
  }>;
};

export type StaffDeviceCommandListItem = {
  id: string;
  type: DeviceCommandType;
  deviceId: string | null;
  targetKind: DeviceCommand["targetKind"];
  executorKind: DeviceCommand["executorKind"];
  playerId: string | null;
  staffId: string | null;
  status: DeviceCommand["status"];
  requestedAt: Date;
  ackedAt: Date | null;
  expiredAt: Date | null;
  payload: Record<string, unknown> | null;
};

export type StaffReportsSummaryInput = {
  from: Date;
  to: Date;
};

export type StaffReportsSummary = StaffReportsSummaryInput & {
  revenueTotal: Cents;
  sessionCount: number;
  assetGrantTotal: number;
  coinCommandCount: number;
};

export type StaffReportSettlementListItem = {
  externalPayment?: { method: string; staffId: string };
  settlementId: string;
  sessionId: string;
  playerId: string;
  playerDisplayName: string;
  startedAt: Date;
  endedAt: Date | null;
  settledAt: Date;
  durationMinutes: number | null;
  subtotal: Cents;
  total: Cents;
};

export type ReportArchiveFilter = "active" | "archived" | "all";
export type StaffReportCheckout = {
  checkoutId: string;
  playerId: string;
  playerDisplayName: string;
  startedAt: string | null;
  endedAt: string | null;
  settledAt: string;
  durationMinutes: number;
  sessionCount: number;
  subtotal: number;
  total: number;
  archived: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  externalPayment?: { method: string; staffId: string; collectedAt: string };
};
export type StaffReportCheckoutDetail = {
  record: StaffReportCheckout;
  receipt: PlayerCheckoutReceipt;
};

export type StaffReportPlayerListItem = {
  playerId: string;
  playerDisplayName: string;
  settlementCount: number;
  totalDurationMinutes: number;
  revenueTotal: Cents;
  lastSettledAt: Date;
};

export type StaffQueries = {
  listPlayers(input?: { playerIds?: readonly string[] }): Promise<StaffPlayerListItem[]>;
  listActiveSessions(): Promise<StaffActiveSessionListItem[]>;
  listLiveSessions?(input?: { playerIds?: readonly string[] }): Promise<StaffActiveSessionListItem[]>;
  getPlayerAssets?(playerId: string): Promise<PlayerAssets>;
  getPlayerSessionHistory?(playerId: string): Promise<SessionHistoryListItem[]>;
  getPlayerSessionHistoryDetail?(playerId: string, sessionId: string): Promise<SessionHistoryDetail | null>;
  listPlayerRedeemRecords?(playerId: string): Promise<PlayerRedeemRecordListItem[]>;
  listDeviceCommands?(input: { limit: number }): Promise<StaffDeviceCommandListItem[]>;
  listDeviceStates?(): Promise<DeviceState[]>;
  listMachineConnections?(): Promise<MachineConnection[]>;
  getReportsSummary?(input: StaffReportsSummaryInput): Promise<StaffReportsSummary>;
  listReportCheckouts?(input: StaffReportsSummaryInput & { limit: number; offset?: number; archive?: ReportArchiveFilter }): Promise<StaffReportCheckout[]>;
  getReportCheckout?(checkoutId: string): Promise<StaffReportCheckoutDetail | null>;
  listReportSettlements?(input: StaffReportsSummaryInput & { limit: number; offset?: number }): Promise<StaffReportSettlementListItem[]>;
  listReportPlayers?(input: StaffReportsSummaryInput & { limit: number; offset?: number }): Promise<StaffReportPlayerListItem[]>;
};

export type StaffRedeemQueries = {
  listRedeemCodeRedemptions?(): Promise<StaffRedeemCodeRedemptionListItem[]>;
};

export type ApplicationQueries = {
  playerQueries: PlayerQueries;
  staffQueries: StaffQueries;
  staffRedeemQueries?: StaffRedeemQueries;
};
