import {
  MEMBER_ASSET_TYPE,
  MEMBER_PROGRAM_KEY,
  PrismDomainError,
  adjustAssets,
  centsOfInteger,
  deductCurrency,
  diffAssetHoldings,
  grantAssets,
  isActiveInWindow,
  isMemberAsset,
  memberDurationMs,
  sumCents,
  type AssetDefinitionRepository,
  type AssetRepository,
  type Cents,
  type MemberPlan,
  type MemberProgram,
  type MemberStatus,
  type OperationLockRepository,
  type SystemRepository,
} from "@prism/core";
import { sumAvailableWalletBalance, type AvailableAssetReader } from "./available-assets";
import { PLAYER_BILLING_LOCK_SCOPE, withOperationLease } from "./operation-lock";

export type MemberPurchaseResult = {
  status: MemberStatus;
  price: Cents;
  walletBefore: Cents;
  walletAfter: Cents;
};

export type MemberGrantResult = {
  status: MemberStatus;
};

export type MemberProgramView = MemberProgram;

export type MemberServiceDependencies = {
  system: SystemRepository;
  assets: AssetRepository;
  availableAssets: AvailableAssetReader;
  assetDefinitions: AssetDefinitionRepository;
  operationLocks: OperationLockRepository;
  id: () => string;
  now: () => Date;
};

export type MemberService = {
  getProgram(): Promise<MemberProgramView>;
  saveProgram(input: { enabled: boolean }): Promise<MemberProgramView>;
  savePlan(input: {
    id?: string;
    name: string;
    assetCode: string;
    price: Cents;
    durationDays: number;
  }): Promise<MemberPlan>;
  archivePlan(input: { planId: string }): Promise<MemberPlan>;
  restorePlan(input: { planId: string }): Promise<MemberPlan>;
  getStatus(playerId: string, at?: Date): Promise<MemberStatus>;
  isMember(playerId: string, at?: Date): Promise<boolean>;
  purchase(input: { playerId: string; planId: string }): Promise<MemberPurchaseResult>;
  grant(input: { playerId: string; planId: string; staffId: string; operationId?: string }): Promise<MemberGrantResult>;
  revoke(input: { playerId: string; staffId: string; operationId?: string }): Promise<MemberGrantResult>;
};

type StoredMemberPlan = {
  id: string;
  name: string;
  assetCode: string;
  priceCents: number;
  durationDays: number;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

type StoredMemberProgram = {
  enabled: boolean;
  plans: StoredMemberPlan[];
};

const EMPTY_PROGRAM: StoredMemberProgram = { enabled: false, plans: [] };

export function createMemberService(dependencies: MemberServiceDependencies): MemberService {
  async function readStoredProgram(): Promise<StoredMemberProgram> {
    return normalizeStoredProgram(
      await dependencies.system.getAppSetting<unknown>(MEMBER_PROGRAM_KEY),
    );
  }

  async function writeStoredProgram(program: StoredMemberProgram): Promise<void> {
    await dependencies.system.setAppSetting(MEMBER_PROGRAM_KEY, program);
  }

  async function getStatus(playerId: string, at = dependencies.now()): Promise<MemberStatus> {
    const program = await readStoredProgram();
    const holdings = await dependencies.assets.listAssetHoldings(playerId);
    const holding = holdings
      .filter((item) => isMemberAsset(item.assetType) && item.quantity > 0)
      .filter((item) => (!item.activeAt || item.activeAt.getTime() <= at.getTime())
        && (!item.expiresAt || item.expiresAt.getTime() > at.getTime()))
      .sort((left, right) => (right.expiresAt?.getTime() ?? Infinity) - (left.expiresAt?.getTime() ?? Infinity))[0];
    if (!holding) {
      return {
        active: false,
        enabled: program.enabled,
        assetCode: null,
        cardName: null,
        discountPercent: null,
        expiresAt: null,
      };
    }
    const definition = await dependencies.assetDefinitions.findByCode(
      MEMBER_ASSET_TYPE,
      holding.assetCode,
    );
    if (!definition || definition.status === "archived") {
      return {
        active: false,
        enabled: program.enabled,
        assetCode: holding.assetCode,
        cardName: null,
        discountPercent: null,
        expiresAt: holding.expiresAt ?? null,
      };
    }
    const effect = definition.pricingEffect;
    const usableEffect = effect && effect.status !== "archived" && isActiveInWindow(effect, at)
      ? effect
      : null;
    return {
      active: program.enabled,
      enabled: program.enabled,
      assetCode: holding.assetCode,
      cardName: definition.name,
      discountPercent: usableEffect?.type === "percentage-discount" ? usableEffect.value : null,
      expiresAt: holding.expiresAt ?? null,
    };
  }

  async function activePlan(program: StoredMemberProgram, planId: string): Promise<MemberPlan> {
    const plan = program.plans.find((item) => item.id === planId);
    if (!plan) throw new PrismDomainError("会员方案不存在", "MEMBER_PLAN_NOT_FOUND");
    if (plan.status !== "active") {
      throw new PrismDomainError("会员方案已下架", "MEMBER_PLAN_ARCHIVED");
    }
    return toPlan(plan);
  }

  async function assertMembershipCard(assetCode: string): Promise<void> {
    const definition = await dependencies.assetDefinitions.findByCode(MEMBER_ASSET_TYPE, assetCode);
    if (!definition || definition.status === "archived") {
      throw new PrismDomainError("请选择有效的会员卡", "MEMBER_CARD_NOT_FOUND");
    }
  }

  async function grantMembership(input: {
    playerId: string;
    planId: string;
    reason: string;
    refId: string;
    kind: string;
    metadata: Record<string, unknown>;
  }): Promise<MemberGrantResult> {
    const program = await readStoredProgram();
    if (!program.enabled) {
      throw new PrismDomainError("会员体系尚未启用", "MEMBER_PROGRAM_DISABLED");
    }
    const plan = await activePlan(program, input.planId);
    const now = dependencies.now();
    const existing = await dependencies.assets.listAssetHoldings(input.playerId);
    const granted = grantAssets({
      playerId: input.playerId,
      existingHoldings: existing,
      grants: [{
        assetType: MEMBER_ASSET_TYPE,
        assetCode: plan.assetCode,
        amount: 1,
        mergeStrategy: "extend-time",
        activeAt: now,
        expiresAt: null,
        durationMs: memberDurationMs(plan.durationDays),
        reason: input.reason,
        refId: input.refId,
      }],
      idFactory: dependencies.id,
      now,
    });
    const transactionId = dependencies.id();
    await dependencies.assets.commitAssetTransaction({
      transaction: {
        id: transactionId,
        playerId: input.playerId,
        kind: input.kind,
        refId: input.refId,
        createdAt: now,
        metadata: {
          ...input.metadata,
          planId: plan.id,
          planName: plan.name,
          assetCode: plan.assetCode,
          durationDays: plan.durationDays,
          priceCents: plan.price,
        },
      },
      holdingChanges: diffAssetHoldings(
        existing,
        granted.holdings.filter((holding) => holding.quantity > 0),
      ),
      assetLedgerEntries: granted.assetLedgerEntries,
    });
    return { status: await getStatus(input.playerId) };
  }

  return {
    getProgram: async () => toProgramView(await readStoredProgram()),

    async saveProgram(input) {
      const current = await readStoredProgram();
      const next: StoredMemberProgram = { ...current, enabled: input.enabled === true };
      await writeStoredProgram(next);
      return toProgramView(next);
    },

    async savePlan(input) {
      const program = await readStoredProgram();
      const name = input.name.trim();
      if (!name) throw new PrismDomainError("会员方案名称不能为空", "INVALID_MEMBER_PLAN_NAME");
      if (name.length > 40) throw new PrismDomainError("会员方案名称过长", "INVALID_MEMBER_PLAN_NAME");
      if (!input.assetCode.trim()) {
        throw new PrismDomainError("请选择会员卡", "MEMBER_CARD_REQUIRED");
      }
      await assertMembershipCard(input.assetCode.trim());
      if (!Number.isInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 3650) {
        throw new PrismDomainError("会员时长必须是 1 到 3650 天", "INVALID_MEMBER_PLAN_DURATION");
      }
      if (!Number.isSafeInteger(input.price) || input.price < 0) {
        throw new PrismDomainError("会员价格无效", "INVALID_MEMBER_PLAN_PRICE");
      }
      const now = dependencies.now();
      const existing = input.id ? program.plans.find((plan) => plan.id === input.id) : undefined;
      if (!existing && program.plans.length >= 20) {
        throw new PrismDomainError("会员方案最多 20 个", "MEMBER_PLAN_LIMIT");
      }
      const plan: StoredMemberPlan = {
        id: existing?.id ?? input.id ?? `member-plan-${dependencies.id()}`,
        name,
        assetCode: input.assetCode.trim(),
        priceCents: input.price,
        durationDays: input.durationDays,
        status: existing?.status ?? "active",
        createdAt: existing?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      };
      const plans = existing
        ? program.plans.map((item) => item.id === existing.id ? plan : item)
        : [...program.plans, plan];
      await writeStoredProgram({ ...program, plans });
      return toPlan(plan);
    },

    async archivePlan(input) {
      const program = await readStoredProgram();
      const existing = program.plans.find((plan) => plan.id === input.planId);
      if (!existing) throw new PrismDomainError("会员方案不存在", "MEMBER_PLAN_NOT_FOUND");
      const plan: StoredMemberPlan = { ...existing, status: "archived", updatedAt: dependencies.now().toISOString() };
      await writeStoredProgram({
        ...program,
        plans: program.plans.map((item) => item.id === plan.id ? plan : item),
      });
      return toPlan(plan);
    },

    async restorePlan(input) {
      const program = await readStoredProgram();
      const existing = program.plans.find((plan) => plan.id === input.planId);
      if (!existing) throw new PrismDomainError("会员方案不存在", "MEMBER_PLAN_NOT_FOUND");
      const plan: StoredMemberPlan = { ...existing, status: "active", updatedAt: dependencies.now().toISOString() };
      await writeStoredProgram({
        ...program,
        plans: program.plans.map((item) => item.id === plan.id ? plan : item),
      });
      return toPlan(plan);
    },

    getStatus,

    isMember: async (playerId, at) => (await getStatus(playerId, at)).active,

    async purchase(input) {
      return withOperationLease({
        repository: dependencies.operationLocks,
        scope: PLAYER_BILLING_LOCK_SCOPE,
        resourceId: input.playerId,
        id: dependencies.id,
        now: dependencies.now,
      }, async () => {
        const program = await readStoredProgram();
        if (!program.enabled) {
          throw new PrismDomainError("会员体系尚未启用", "MEMBER_PROGRAM_DISABLED");
        }
        const plan = await activePlan(program, input.planId);
        const now = dependencies.now();
        const transactionId = dependencies.id();
        const existing = await dependencies.assets.listAssetHoldings(input.playerId);
        const granted = grantAssets({
          playerId: input.playerId,
          existingHoldings: existing,
          grants: [{
            assetType: MEMBER_ASSET_TYPE,
            assetCode: plan.assetCode,
            amount: 1,
            mergeStrategy: "extend-time",
            activeAt: now,
            expiresAt: null,
            durationMs: memberDurationMs(plan.durationDays),
            reason: "membership.purchase",
            refId: transactionId,
          }],
          idFactory: dependencies.id,
          now,
        });
        const available = await dependencies.availableAssets.resolveAvailableHoldings(
          granted.holdings,
          { at: now, includeHidden: true },
        );
        const walletBefore = sumAvailableWalletBalance(available);
        const price = centsOfInteger(plan.price);
        const currencyEntries = deductCurrency(
          available.map((asset) => asset.holding),
          { amount: price, reason: "membership.purchase", refId: transactionId, now },
        );
        const walletAfter = sumCents(
          available
            .filter((asset) => asset.holding.assetType === "currency")
            .map((asset) => centsOfInteger(asset.holding.quantity)),
        );
        await dependencies.assets.commitAssetTransaction({
          transaction: {
            id: transactionId,
            playerId: input.playerId,
            kind: "membership.purchase",
            refId: plan.id,
            createdAt: now,
            metadata: {
              planId: plan.id,
              planName: plan.name,
              assetCode: plan.assetCode,
              priceCents: plan.price,
              durationDays: plan.durationDays,
              walletBefore,
              walletAfter,
            },
          },
          holdingChanges: diffAssetHoldings(
            existing,
            granted.holdings.filter((holding) => holding.quantity > 0),
          ),
          assetLedgerEntries: [...granted.assetLedgerEntries, ...currencyEntries],
        });
        return {
          status: await getStatus(input.playerId),
          price,
          walletBefore,
          walletAfter,
        };
      });
    },

    async grant(input) {
      return withOperationLease({
        repository: dependencies.operationLocks,
        scope: PLAYER_BILLING_LOCK_SCOPE,
        resourceId: input.playerId,
        id: dependencies.id,
        now: dependencies.now,
      }, async () => {
        if (input.operationId) {
          const transactions = await dependencies.assets.listTransactionsByPlayerId(input.playerId);
          const replayed = transactions.find((transaction) =>
            transaction.kind === "staff.membership.grant"
            && transaction.metadata?.operationId === input.operationId);
          if (replayed) return { status: await getStatus(input.playerId) };
        }
        return grantMembership({
          playerId: input.playerId,
          planId: input.planId,
          reason: "staff.membership.grant",
          refId: input.staffId,
          kind: "staff.membership.grant",
          metadata: { staffId: input.staffId, ...(input.operationId ? { operationId: input.operationId } : {}) },
        });
      });
    },

    async revoke(input) {
      return withOperationLease({
        repository: dependencies.operationLocks,
        scope: PLAYER_BILLING_LOCK_SCOPE,
        resourceId: input.playerId,
        id: dependencies.id,
        now: dependencies.now,
      }, async () => {
        const now = dependencies.now();
        const existing = await dependencies.assets.listAssetHoldings(input.playerId);
        const holdings = existing.filter((holding) => isMemberAsset(holding.assetType));
        if (holdings.length) {
          const adjusted = adjustAssets({
            playerId: input.playerId,
            existingHoldings: existing,
            adjustments: holdings.map((holding) => ({
              holdingId: holding.id,
              assetType: holding.assetType,
              assetCode: holding.assetCode,
              quantityDelta: -holding.quantity,
              reason: "staff.membership.revoke",
              refId: input.staffId,
            })),
          });
          await dependencies.assets.commitAssetTransaction({
            transaction: {
              id: dependencies.id(),
              playerId: input.playerId,
              kind: "staff.membership.revoke",
              refId: input.staffId,
              createdAt: now,
              metadata: { staffId: input.staffId, ...(input.operationId ? { operationId: input.operationId } : {}) },
            },
            holdingChanges: diffAssetHoldings(
              existing,
              adjusted.holdings.filter((holding) => holding.quantity > 0),
            ),
            assetLedgerEntries: adjusted.assetLedgerEntries,
          });
        }
        return { status: await getStatus(input.playerId) };
      });
    },
  };
}

function toProgramView(program: StoredMemberProgram): MemberProgramView {
  return {
    enabled: program.enabled,
    plans: program.plans
      .map(toPlan)
      .sort((left, right) =>
        Number(left.status === "archived") - Number(right.status === "archived")
        || left.durationDays - right.durationDays
        || left.name.localeCompare(right.name),
      ),
  };
}

function toPlan(plan: StoredMemberPlan): MemberPlan {
  return {
    id: plan.id,
    name: plan.name,
    assetCode: plan.assetCode,
    price: centsOfInteger(plan.priceCents),
    durationDays: plan.durationDays,
    status: plan.status,
    createdAt: new Date(plan.createdAt),
    updatedAt: new Date(plan.updatedAt),
  };
}

function normalizeStoredProgram(raw: unknown): StoredMemberProgram {
  if (!isRecord(raw)) return { ...EMPTY_PROGRAM };
  return {
    enabled: raw.enabled === true,
    plans: Array.isArray(raw.plans)
      ? raw.plans.flatMap((entry) => normalizeStoredPlan(entry))
      : [],
  };
}

function normalizeStoredPlan(raw: unknown): StoredMemberPlan[] {
  if (!isRecord(raw)) return [];
  if (typeof raw.id !== "string" || !raw.id.trim()) return [];
  if (typeof raw.name !== "string" || !raw.name.trim()) return [];
  if (typeof raw.assetCode !== "string" || !raw.assetCode.trim()) return [];
  if (!Number.isSafeInteger(raw.priceCents) || (raw.priceCents as number) < 0) return [];
  if (!Number.isInteger(raw.durationDays) || (raw.durationDays as number) < 1) return [];
  const createdAt = typeof raw.createdAt === "string" && !Number.isNaN(Date.parse(raw.createdAt))
    ? raw.createdAt
    : new Date(0).toISOString();
  const updatedAt = typeof raw.updatedAt === "string" && !Number.isNaN(Date.parse(raw.updatedAt))
    ? raw.updatedAt
    : createdAt;
  return [{
    id: raw.id,
    name: raw.name.trim(),
    assetCode: raw.assetCode.trim(),
    priceCents: raw.priceCents as number,
    durationDays: raw.durationDays as number,
    status: raw.status === "archived" ? "archived" : "active",
    createdAt,
    updatedAt,
  }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
