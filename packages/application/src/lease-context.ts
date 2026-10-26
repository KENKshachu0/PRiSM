import { AsyncLocalStorage } from "node:async_hooks";

/** The leases the current async call chain already holds. */
export type LeaseContext = {
  held(): ReadonlySet<string> | undefined;
  run<T>(held: ReadonlySet<string>, action: () => Promise<T>): Promise<T>;
};

const storage = new AsyncLocalStorage<ReadonlySet<string>>();

export const leaseContext: LeaseContext = {
  held: () => storage.getStore(),
  run: (held, action) => storage.run(held, action),
};
