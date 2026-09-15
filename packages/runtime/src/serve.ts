import { Database } from "bun:sqlite";
import {
  handleMachineWebSocketClose,
  handleMachineWebSocketMessage,
} from "@prism/server-hono";
import { createPrismLocalDependencies, initializeSqliteSchema } from "./index";
import { createPrismLocalFetchHandler } from "./local-server";

const databasePath = process.env.PRISM_SQLITE_PATH ?? "./prism.sqlite";
const port = Number.parseInt(process.env.PORT ?? "8787", 10);

process.on("uncaughtException", (error) => {
  console.error("[prism] uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[prism] unhandled rejection:", reason);
});

const db = new Database(databasePath);
const playerColumns = db.query("PRAGMA table_info(players)").all() as {
  name: string;
}[];
if (
  playerColumns.length &&
  !playerColumns.some((column) => column.name === "shop_id")
) {
  const migration = await Bun.file(
    new URL(
      "../../../migrations/0016_shop_scoped_billing.sql",
      import.meta.url,
    ),
  ).text();
  const backupPath = `${databasePath}.before-shops-${Date.now()}.sqlite`;
  db.run("VACUUM INTO ?", [backupPath]);
  db.run("PRAGMA foreign_keys=ON");
  db.transaction(() => db.exec(migration))();
  console.log("Created pre-migration SQLite backup:", backupPath);
}
const quantityColumn = db.query<{ name: string; type: string }, []>(
  "PRAGMA table_info(asset_holdings)",
).all().find(column => column.name === "quantity");
if (quantityColumn && quantityColumn.type.toUpperCase() !== "INTEGER") {
  const migration = await Bun.file(new URL(
    "../../../migrations/0022_integer_money_columns.sql", import.meta.url,
  )).text();
  const backupPath = `${databasePath}.before-integer-money-${Date.now()}.sqlite`;
  db.run("VACUUM INTO ?", [backupPath]);
  db.run("PRAGMA foreign_keys=ON");
  db.transaction(() => db.exec(migration))();
  console.log("Created pre-integer-money SQLite backup:", backupPath);
}
initializeSqliteSchema(db);

const dependencies = createPrismLocalDependencies({
  db,
});
const fetch = createPrismLocalFetchHandler(dependencies);

Bun.serve({
  port,
  fetch,
  websocket: {
    async message(socket, message) {
      try {
        await handleMachineWebSocketMessage(socket, message, dependencies);
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "error",
            code:
              error instanceof Error && "code" in error
                ? String(error.code)
                : "MACHINE_WS_ERROR",
            message:
              error instanceof Error
                ? error.message
                : "Machine WebSocket error.",
          }),
        );
      }
    },
    close(socket) {
      void handleMachineWebSocketClose(socket, dependencies);
    },
  },
});

console.log(`PRiSM local API listening on http://localhost:${port}`);
