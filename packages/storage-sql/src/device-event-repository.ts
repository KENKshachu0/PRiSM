import type {
  DeviceEvent,
  DeviceEventRepository,
  DeviceOperation,
  DeviceRecord,
  DeviceStateValue,
} from "@prism/core";
import type { SqlExecutor, SqlStatement } from "./repositories";
import { sqlShop } from "./shop-scope";

type EventRow = {
  id: string;
  device_id: string | null;
  capability: string;
  kind: DeviceEvent["kind"];
  name: string;
  operation_id: string | null;
  parent_operation_id: string | null;
  origin: DeviceEvent["origin"];
  player_id: string | null;
  staff_id: string | null;
  payload_json: string;
  occurred_at: string;
};

type OperationRow = {
  id: string;
  device_id: string | null;
  capability: string;
  action: string;
  parent_id: string | null;
  player_id: string | null;
  staff_id: string | null;
  status: DeviceOperation["status"];
  counts_as_play: number;
  failure: string | null;
  payload_json: string;
  requested_at: string;
  settled_at: string | null;
  confirmed_at: string | null;
};

type StateRow = {
  device_id: string;
  capability: string;
  key: string;
  value_json: string;
  authority: DeviceStateValue["authority"];
  event_id: string | null;
  changed_at: string;
};

const operationColumns =
  "id, device_id, capability, action, parent_id, player_id, staff_id, status, counts_as_play, failure, payload_json, requested_at, settled_at, confirmed_at";

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toEvent(row: EventRow): DeviceEvent {
  return {
    id: row.id,
    deviceId: row.device_id,
    capability: row.capability,
    kind: row.kind,
    name: row.name,
    operationId: row.operation_id,
    parentOperationId: row.parent_operation_id,
    origin: row.origin,
    playerId: row.player_id,
    staffId: row.staff_id,
    payload: parseObject(row.payload_json),
    occurredAt: new Date(row.occurred_at),
  };
}

function toOperation(row: OperationRow): DeviceOperation {
  return {
    id: row.id,
    deviceId: row.device_id,
    capability: row.capability,
    action: row.action,
    parentId: row.parent_id,
    playerId: row.player_id,
    staffId: row.staff_id,
    status: row.status,
    countsAsPlay: row.counts_as_play === 1,
    failure: row.failure,
    payload: parseObject(row.payload_json),
    requestedAt: new Date(row.requested_at),
    settledAt: row.settled_at ? new Date(row.settled_at) : null,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
  };
}

function toState(row: StateRow): DeviceStateValue {
  return {
    deviceId: row.device_id,
    capability: row.capability,
    key: row.key,
    value: parseValue(row.value_json),
    authority: row.authority,
    eventId: row.event_id,
    changedAt: new Date(row.changed_at),
    observedAt: new Date(row.changed_at),
  };
}

function insertEvent(shop: string, event: DeviceEvent): SqlStatement {
  return {
    sql: `INSERT INTO device_events (shop_id, id, device_id, capability, kind, name, operation_id,
            parent_operation_id, origin, player_id, staff_id, payload_json, occurred_at)
          VALUES (${shop}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      event.id,
      event.deviceId,
      event.capability,
      event.kind,
      event.name,
      event.operationId,
      event.parentOperationId,
      event.origin,
      event.playerId,
      event.staffId,
      JSON.stringify(event.payload),
      event.occurredAt.toISOString(),
    ],
  };
}

/**
 * A change event is inserted only when the stored value differs. The guard is
 * evaluated in SQL inside the same batch as the state upsert that follows, so a
 * repeated observation adds neither a row nor a state write, without a read
 * round trip first.
 */
function insertChangeIfDifferent(
  shop: string,
  event: DeviceEvent,
  write: { deviceId: string; capability: string; key: string; value: string },
): SqlStatement {
  return {
    sql: `INSERT INTO device_events (shop_id, id, device_id, capability, kind, name, operation_id,
            parent_operation_id, origin, player_id, staff_id, payload_json, occurred_at)
          SELECT ${shop}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM device_state WHERE shop_id = ${shop}
            AND device_id = ? AND capability = ? AND key = ? AND value_json = ?)`,
    params: [
      event.id,
      event.deviceId,
      event.capability,
      event.kind,
      event.name,
      event.operationId,
      event.parentOperationId,
      event.origin,
      event.playerId,
      event.staffId,
      JSON.stringify(event.payload),
      event.occurredAt.toISOString(),
      write.deviceId,
      write.capability,
      write.key,
      write.value,
    ],
  };
}

export function createDeviceEventRepository(executor: SqlExecutor): DeviceEventRepository {
  const shop = sqlShop(executor);
  return {
    async record(input: DeviceRecord) {
      const statements: SqlStatement[] = input.events.map((event) => insertEvent(shop, event));

      if (input.operation) {
        const op = input.operation;
        statements.push({
          sql: `INSERT INTO device_operations (shop_id, ${operationColumns})
                VALUES (${shop}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            op.id,
            op.deviceId,
            op.capability,
            op.action,
            op.parentId,
            op.playerId,
            op.staffId,
            op.status,
            op.countsAsPlay ? 1 : 0,
            op.failure,
            JSON.stringify(op.payload),
            op.requestedAt.toISOString(),
            op.settledAt?.toISOString() ?? null,
            op.confirmedAt?.toISOString() ?? null,
          ],
        });
      }

      if (input.settle) {
        // Only a pending operation is settled: a late or duplicate result must
        // not overturn an outcome that has already been recorded.
        statements.push({
          sql: `UPDATE device_operations SET status = ?, failure = ?, settled_at = ?
                WHERE shop_id = ${shop} AND id = ? AND status = 'pending'`,
          params: [
            input.settle.status,
            input.settle.failure,
            input.settle.settledAt.toISOString(),
            input.settle.operationId,
          ],
        });
      }

      if (input.confirm) {
        statements.push({
          sql: `UPDATE device_operations SET confirmed_at = ?
                WHERE shop_id = ${shop} AND id = ? AND device_id = ? AND confirmed_at IS NULL`,
          params: [input.confirm.confirmedAt.toISOString(), input.confirm.operationId, input.confirm.deviceId],
        });
      }

      for (const { write, event } of input.states ?? []) {
        const value = JSON.stringify(write.value ?? null);
        const target = { ...write, value };
        // Order matters: the change guard must read the old value before the
        // upsert below replaces it.
        if (event) statements.push(insertChangeIfDifferent(shop, event, target));
        statements.push({
          sql: `INSERT INTO device_state (shop_id, device_id, capability, key, value_json, authority, event_id, changed_at)
                VALUES (${shop}, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(shop_id, device_id, capability, key) DO UPDATE SET
                  value_json = excluded.value_json,
                  authority = excluded.authority,
                  event_id = excluded.event_id,
                  changed_at = excluded.changed_at
                WHERE device_state.value_json != excluded.value_json`,
          params: [
            write.deviceId,
            write.capability,
            write.key,
            value,
            write.authority,
            event?.id ?? null,
            (event?.occurredAt ?? write.at ?? new Date()).toISOString(),
          ],
        });
      }

      if (statements.length) await executor.batch(statements);
    },

    async listEvents({ deviceId, limit }) {
      const rows = await executor.all<EventRow>(
        `SELECT id, device_id, capability, kind, name, operation_id, parent_operation_id, origin,
                player_id, staff_id, payload_json, occurred_at
         FROM device_events WHERE shop_id = ${shop} AND device_id = ?
         ORDER BY occurred_at DESC, id DESC LIMIT ?`,
        [deviceId, limit],
      );
      return rows.map(toEvent);
    },

    async getOperation(id) {
      const row = await executor.first<OperationRow>(
        `SELECT ${operationColumns} FROM device_operations WHERE shop_id = ${shop} AND id = ?`,
        [id],
      );
      return row ? toOperation(row) : null;
    },

    async listOperationsByPlayer(playerId) {
      const rows = await executor.all<OperationRow>(
        `SELECT ${operationColumns} FROM device_operations
         WHERE shop_id = ${shop} AND player_id = ? ORDER BY requested_at`,
        [playerId],
      );
      return rows.map(toOperation);
    },

    async listRecentOperations(limit) {
      const rows = await executor.all<OperationRow>(
        `SELECT ${operationColumns} FROM device_operations
         WHERE shop_id = ${shop} ORDER BY requested_at DESC, id LIMIT ?`,
        [limit],
      );
      return rows.map(toOperation);
    },

    async listState(deviceIds) {
      if (deviceIds && !deviceIds.length) return [];
      const rows = deviceIds
        ? await executor.all<StateRow>(
            `SELECT device_id, capability, key, value_json, authority, event_id, changed_at
             FROM device_state WHERE shop_id = ${shop}
               AND device_id IN (SELECT value FROM json_each(?))`,
            [JSON.stringify(deviceIds)],
          )
        : await executor.all<StateRow>(
            `SELECT device_id, capability, key, value_json, authority, event_id, changed_at
             FROM device_state WHERE shop_id = ${shop}`,
          );
      return rows.map(toState);
    },
  };
}
