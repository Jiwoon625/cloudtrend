/** Historical CLI reads only. No remote credentials or mutable serving-cache fallback. */
import { createHash } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
// The executable Python reader is pinned inside this reviewed runtime graph.
export const ARCHIVE_READER_SHA256 =
  "20f1601201fa74e1e048f76c109e848d3e48b56bf90812c5f38a20763415d6ba";
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const owner = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function historicalArchivePath(key: string) {
  const parts = key.split("/");
  return (
    owner.test(parts[0] ?? "") &&
    parts.every((p) => p && p !== "." && p !== "..") &&
    !/[\\%?#]/.test(key) &&
    ![...key].some((c) => c.charCodeAt(0) < 32) &&
    /^(?:results\/(?:screening|backtest)\/|source\/screening\/)/.test(parts.slice(1).join("/"))
  );
}
export function isMissingStorageObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  // Storage's legacy missing-object response uses HTTP 400 with statusCode 404.
  const status = Number(e.statusCode ?? e.status);
  if (status === 401 || status === 403 || status >= 500) return false;
  return (
    status === 404 ||
    ["NoSuchKey", "not_found", "NotFound"].includes(String(e.code)) ||
    ((status === 400 || !Number.isFinite(status)) &&
      /^object not found[.!]?$/i.test(String(e.message)))
  );
}
interface ArchiveObject {
  name: string;
  size: number;
  sha256: string;
  package: string;
}
let indexCache: { identity: string; objects: Map<string, ArchiveObject> } | undefined;
async function archiveObjects(index: string, pin: string) {
  if (!/^[a-f0-9]{64}$/.test(pin))
    throw new Error("CLOUDTREND_DRIVE_ARCHIVE_INDEX_SHA256 is required");
  const identity = `${index}:${pin}`;
  if (indexCache?.identity === identity) return indexCache.objects;
  const info = await stat(index);
  if (info.size > 32 * 1024 * 1024) throw new Error("Archive index exceeds limit");
  const bytes = await readFile(index);
  if (digest(bytes) !== pin) throw new Error("Drive archive index SHA256 mismatch");
  const doc = JSON.parse(bytes.toString("utf8"));
  if (doc.sourceBucket !== "cloudtrend-data" || !Array.isArray(doc.objects))
    throw new Error("Invalid Drive archive index");
  const objects = new Map<string, ArchiveObject>();
  for (const r of doc.objects as ArchiveObject[]) {
    if (
      !r ||
      typeof r.name !== "string" ||
      objects.has(r.name) ||
      !Number.isSafeInteger(r.size) ||
      r.size < 0 ||
      !/^[a-f0-9]{64}$/.test(r.sha256)
    )
      throw new Error("Invalid archive object descriptor");
    objects.set(r.name, r);
  }
  indexCache = { identity, objects };
  return objects;
}
/** A configured, hash-pinned Drive index is the only archive authority. */
export async function readArchivedObject(
  key: string,
  maxBytes = 80 * 1024 * 1024,
): Promise<Buffer | null> {
  if (!historicalArchivePath(key)) return null;
  const index = process.env["CLOUDTREND_DRIVE_ARCHIVE_INDEX"];
  if (!index) return null;
  const pin = process.env["CLOUDTREND_DRIVE_ARCHIVE_INDEX_SHA256"] ?? "";
  const record = (await archiveObjects(path.resolve(index), pin)).get(key);
  if (!record) return null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || record.size > maxBytes)
    throw new Error("Archived object exceeds caller read limit");
  let bytes: Buffer;
  const restored = process.env["CLOUDTREND_ARCHIVE_OBJECT_ROOT"];
  if (restored) {
    const root = await realpath(restored);
    const file = await realpath(path.join(root, key));
    if (!file.startsWith(root + path.sep)) throw new Error("Archive object escapes restore root");
    const info = await stat(file);
    if (info.size !== record.size) throw new Error("Archived object size mismatch");
    bytes = await readFile(file);
  } else {
    const helper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "read-drive-archive.py",
    );
    if (digest(await readFile(helper)) !== ARCHIVE_READER_SHA256)
      throw new Error("Drive archive reader source differs from reviewed runtime");
    try {
      const result = await execute(
        process.env["CLOUDTREND_ARCHIVE_PYTHON"] ?? "python3",
        [
          helper,
          "--index",
          path.resolve(index),
          "--index-sha256",
          pin,
          "--key",
          key,
          "--max-bytes",
          String(maxBytes),
        ],
        { encoding: "buffer", maxBuffer: Math.max(record.size + 1024, 8192), timeout: 180_000 },
      );
      bytes = result.stdout;
    } catch {
      throw new Error(
        "Drive archive read failed; check mounted Drive, index pin and complete ZIP parts",
      );
    }
  }
  if (bytes.length !== record.size || digest(bytes) !== record.sha256)
    throw new Error("Archived object SHA256/size mismatch");
  return bytes;
}
