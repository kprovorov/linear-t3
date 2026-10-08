import { createHash } from "node:crypto";

// Fixed namespace, so the same name always maps to the same id.
const NAMESPACE = Buffer.from("6f1c2b8e5d3a4f7e9b0c1d2e3f4a5b6c", "hex");

/**
 * Deterministic UUID derived from `name` (RFC 4122 v5 hashing). `version` sets the version
 * nibble; Linear only accepts ids in v4 format, T3 uses v5.
 */
export function stableUuid(name: string, version: 4 | 5 = 5): string {
  const bytes = createHash("sha1").update(NAMESPACE).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | (version << 4);
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
