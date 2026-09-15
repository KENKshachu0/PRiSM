import type {
  AssetHoldingUnavailableReason,
  AssetQuantity,
  Cents,
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
  quantity: AssetQuantity;
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
  delta: AssetQuantity;
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

export type PlayerQueries = {
  getPlayerSummary(playerId: string): Promise<PlayerSummary>;
  listPlayerAssets?(playerId: string): Promise<PlayerAssets>;
  listPlayerSessionHistory?(playerId: string): Promise<SessionHistoryListItem[]>;
  getPlayerSessionHistoryDetail?(playerId: string, sessionId: string): Promise<SessionHistoryDetail | null>;
};

export type StaffPlayerListItem = {
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
  listLiveSessions?(): Promise<StaffActiveSessionListItem[]>;
  getPlayerAssets?(playerId: string): Promise<PlayerAssets>;
  getPlayerSessionHistory?(playerId: string): Promise<SessionHistoryListItem[]>;
  getPlayerSessionHistoryDetail?(playerId: string, sessionId: string): Promise<SessionHistoryDetail | null>;
  listPlayerRedeemRecords?(playerId: string): Promise<PlayerRedeemRecordListItem[]>;
  listDeviceCommands?(input: { limit: number }): Promise<StaffDeviceCommandListItem[]>;
  listDeviceStates?(): Promise<DeviceState[]>;
  listMachineConnections?(): Promise<MachineConnection[]>;
  getReportsSummary?(input: StaffReportsSummaryInput): Promise<StaffReportsSummary>;
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
