import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readArchivedObject, ARCHIVE_READER_SHA256 } from "./archived-storage";
import { downloadJson } from "./analysis-run-store";
import { createReadOnlyTransport, objectPath } from "./kr-vintage-preflight/transport";

const uid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const key = `${uid}/results/screening/old.json`;
const body = '{"run":{"id":"old"},"preserved":true}';
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "archive-fallback-"));
  temporary.push(root);
  const objects = path.join(root, "objects"),
    file = path.join(objects, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  const index = path.join(root, "index.json");
  const raw = JSON.stringify({
    sourceBucket: "cloudtrend-data",
    objects: [
      { name: key, size: Buffer.byteLength(body), sha256: sha(body), package: "history.zip" },
    ],
  });
  await writeFile(index, raw);
  vi.stubEnv("CLOUDTREND_DRIVE_ARCHIVE_INDEX", index);
  vi.stubEnv("CLOUDTREND_DRIVE_ARCHIVE_INDEX_SHA256", sha(raw));
  vi.stubEnv("CLOUDTREND_ARCHIVE_OBJECT_ROOT", objects);
  return { root, objects, file };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});
function client(error: unknown, data: string | null = null) {
  return {
    storage: {
      from: vi.fn(() => ({
        download: vi.fn(async () => ({
          error,
          data: data === null ? null : new Blob([data]),
        })),
      })),
    },
  } as never;
}
describe("historical archive reads", () => {
  it("pins the Python reader source in the reviewed runtime", async () => {
    expect(
      createHash("sha256")
        .update(await readFile(new URL("./read-drive-archive.py", import.meta.url)))
        .digest("hex"),
    ).toBe(ARCHIVE_READER_SHA256);
  });
  it("recovers missing historical JSON and preserves original run identity", async () => {
    await fixture();
    const result = await downloadJson(
      client({ statusCode: "404", message: "Object not found" }),
      key,
    );
    expect(result).toEqual(JSON.parse(body));
  });
  it("never replaces a live response or hides authorization/network errors", async () => {
    await fixture();
    expect(await downloadJson(client(null, '{"live":true}'), key)).toEqual({ live: true });
    for (const statusCode of [401, 403, 500, 503])
      await expect(
        downloadJson(client({ statusCode, message: "Object not found" }), key),
      ).rejects.toThrow("Supabase");
  });
  it("requires a pinned manifest and verified object bytes", async () => {
    const f = await fixture();
    vi.stubEnv("CLOUDTREND_DRIVE_ARCHIVE_INDEX_SHA256", "b".repeat(64));
    await expect(readArchivedObject(key)).rejects.toThrow("index SHA256");
    await fixture();
    await expect(readArchivedObject(key, 1)).rejects.toThrow("limit");
    const g = await fixture();
    await writeFile(g.file, body.replace("true", "fals"));
    await expect(readArchivedObject(key)).rejects.toThrow("SHA256");
    await rm(f.root, { recursive: true });
  });
  it("does not read mutable caches, unlisted objects or traversal paths", async () => {
    await fixture();
    for (const p of [
      `${uid}/cache/screening/latest.json`,
      `${uid}/results/screening/missing.json`,
      `${uid}/results/screening/../old.json`,
      key.replace(uid, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
    ])
      expect(await readArchivedObject(p)).toBeNull();
  });
  it("rejects symlinks escaping the restored archive root", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside.json");
    await writeFile(outside, body);
    await rm(f.file);
    await symlink(outside, f.file);
    await expect(readArchivedObject(key)).rejects.toThrow("escapes");
  });
  it.each([404, 400])(
    "supports HTTP %s missing-object responses in the bounded recovery transport",
    async (status) => {
      await fixture();
      const p = objectPath("cloudtrend-data", key, uid);
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify({ statusCode: "404", message: "Object not found" }), {
            status,
          }),
      );
      const read = createReadOnlyTransport(
        "https://synthetic.supabase.co",
        "synthetic",
        new Set([p]),
        fetcher,
      );
      expect((await read(p)).toString()).toBe(body);
      await expect(read(p, 1)).rejects.toThrow();
    },
  );
  it("keeps HEAD generation checks and database reads live", async () => {
    await fixture();
    const p = objectPath("cloudtrend-data", key, uid);
    const read = createReadOnlyTransport(
      "https://synthetic.supabase.co",
      "synthetic",
      new Set([p, "/rest/v1/analysis_runs"]),
      async () => new Response(null, { status: 404 }),
    );
    await expect(read(p, 1000, "HEAD")).rejects.toThrow("PREFLIGHT_INPUT_REJECTED");
    await expect(read("/rest/v1/analysis_runs")).rejects.toThrow("PREFLIGHT_INPUT_REJECTED");
  });
});
