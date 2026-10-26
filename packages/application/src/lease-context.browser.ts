import type { LeaseContext } from "./lease-context";

/** Browsers bundle the billing code to quote, never to lock, so nothing nests here. */
export const leaseContext: LeaseContext = {
  held: () => undefined,
  run: (_held, action) => action(),
};
