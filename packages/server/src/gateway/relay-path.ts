/**
 * Public path for the embedded HINATA IO relay.
 *
 * Devices point `[aimeio] serverUrl` at the platform itself and carry no path
 * or query identifier: the channel is resolved from the Bearer token. Keeping
 * this to one fixed prefix makes it a single exemption from the static-asset
 * gate, which otherwise claims every path that is not an API route.
 */
export const machineRelayPath = "/io/ws";
