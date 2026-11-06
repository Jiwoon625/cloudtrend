/** Pure validation primitives: never import a transport, client or subprocess here. */
import { createHash } from "node:crypto";

export const rawHash = (bytes: Uint8Array | string) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");

export function requireCheck(value: unknown): asserts value {
  if (!value) throw new Error("PREFLIGHT_INPUT_REJECTED");
}
