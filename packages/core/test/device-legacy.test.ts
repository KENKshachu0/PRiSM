import { describe, expect, it } from "bun:test";
import { operationToLegacyCommand } from "../src/device-legacy";
import type { DeviceOperation } from "../src/device-events";

const at = new Date("2026-10-26T08:00:00.000Z");

function operation(overrides: Partial<DeviceOperation>): DeviceOperation {
  return {
    id: "op", deviceId: "cabinet", capability: "power", action: "power.on",
    parentId: null, status: "succeeded", countsAsPlay: false, failure: null,
    payload: { deviceLabel: "舞萌" }, requestedAt: at, settledAt: at, confirmedAt: at,
    ...overrides,
  } as DeviceOperation;
}

describe("a device operation as the Bot reads it", () => {
  it("says why a failed action failed", () => {
    const command = operationToLegacyCommand(operation({ status: "failed", failure: "电源未配置" }));
    expect(command.payload!.executorFailure).toEqual({ executorKind: "home_assistant", message: "电源未配置" });
  });

  it("says why an unanswered action is still pending, so a timeout is not just 稍后再试", () => {
    const command = operationToLegacyCommand(operation({ status: "pending", failure: "机台未响应", settledAt: null }));
    expect(command.status).toBe("pending");
    expect(command.payload!.executorFailure).toEqual({ executorKind: "home_assistant", message: "机台未响应" });
  });

  it("adds nothing to a succeeded action", () => {
    expect(operationToLegacyCommand(operation({})).payload?.executorFailure).toBeUndefined();
  });
});
