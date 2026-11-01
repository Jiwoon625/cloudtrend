import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { replayReadBridge } from "./replay-read-bridge";
const uid = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const download = vi.fn(async () => ({ data: new Blob(["remote"]), error: null }));
  const upload = vi.fn(async () => ({ error: null }));
  const api = { download, upload };
  const client = {
    storage: { from: vi.fn(() => api) },
    from() {
      return this.storage;
    },
  };
  const read = vi.fn(async () => new Blob(["validated"]));
  return {
    client,
    api,
    read,
    bridge: replayReadBridge(client as unknown as SupabaseClient, uid, read),
  };
}
it("only planned owner stage reads use validated callback, preserving download return contract", async () => {
  const f = fixture();
  const out = await f.bridge.storage
    .from("cloudtrend-data")
    .download(`${uid}/staging/integrated-allocation-inputs/v1/KR/2026-10-30.json`, {
      cacheNonce: "nonce",
    });
  expect(await out.data?.text()).toBe("validated");
  expect(f.read).toHaveBeenCalledExactlyOnceWith("KR", "2026-10-30");
  expect(f.api.download).not.toHaveBeenCalled();
});
it("forwards unrelated owner/bucket requests without caching and binds SDK methods", async () => {
  const f = fixture();
  const opts = { cacheNonce: "nonce" };
  await f.bridge.storage
    .from("other")
    .download(`${uid}/staging/integrated-allocation-inputs/v1/US/2026-10-30.json`, opts);
  expect(f.api.download).toHaveBeenCalledWith(
    `${uid}/staging/integrated-allocation-inputs/v1/US/2026-10-30.json`,
    opts,
  );
  expect(f.read).not.toHaveBeenCalled();
  expect(f.bridge.from("x")).toBe(f.client.storage);
});
it("does not retry a rejected proof or malformed scoped input", async () => {
  const f = fixture();
  f.read.mockRejectedValue(Error("proof changed"));
  await expect(
    f.bridge.storage
      .from("cloudtrend-data")
      .download(`${uid}/staging/integrated-allocation-inputs/v1/US/2026-10-30.json`),
  ).rejects.toThrow("proof changed");
  await expect(
    f.bridge.storage
      .from("cloudtrend-data")
      .download(`${uid}/staging/integrated-allocation-inputs/v1/US/../bad`),
  ).rejects.toThrow("Unplanned");
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.api.download).not.toHaveBeenCalled();
});
it("leaves immutable uploads entirely with original SDK", async () => {
  const f = fixture();
  const b = new Blob(["x"]);
  await f.bridge.storage.from("cloudtrend-data").upload("path", b, { upsert: false });
  expect(f.api.upload).toHaveBeenCalledWith("path", b, { upsert: false });
});
