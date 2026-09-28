import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getSession: mocks.getSession }, storage: { from: () => mocks } }),
}));
import { readFile, writeFile, readObject, writeObject } from "./cloud";
describe("cloud file persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      data: { session: { user: { id: "owner" } } },
      error: null,
    });
  });
  it("loads the same account path on another browser", async () => {
    mocks.download.mockResolvedValue({
      data: new Blob([JSON.stringify({ text: "csv", meta: {} })]),
      error: null,
    });
    expect(await readFile("kr")).toEqual({ text: "csv", meta: {} });
    expect(mocks.download).toHaveBeenCalledWith("owner/kr.json");
  });
  it.each(["dashboard", "screening"])(
    "reads a new %s revision instead of a cached latest pointer after upload",
    async (kind) => {
      let origin = { revision: "old" };
      const stale = origin;
      mocks.download.mockImplementation(async (_path, options, parameters) => ({
        data: new Blob([
          JSON.stringify(options?.cacheNonce && parameters?.cache === "no-store" ? origin : stale),
        ]),
        error: null,
      }));
      mocks.upload.mockImplementation(async (_path, body) => {
        origin = JSON.parse(await body.text());
        return { error: null };
      });
      const path = `owner/cache/${kind}/latest.json`;
      expect(await readObject(path)).toEqual({ revision: "old" });
      await writeObject(path, { revision: "new" });
      expect(await readObject(path)).toEqual({ revision: "new" });
      expect(mocks.download.mock.calls[0][1].cacheNonce).not.toBe(
        mocks.download.mock.calls[1][1].cacheNonce,
      );
      expect(mocks.upload.mock.calls[0][2].cacheControl).toBe("0");
    },
  );
  it("does not report network failures as empty data", async () => {
    mocks.download.mockResolvedValue({ error: { message: "offline" } });
    await expect(readFile("us")).rejects.toThrow("offline");
  });
  it("handles a new account with no files", async () => {
    mocks.download.mockResolvedValue({ error: { statusCode: "404", message: "Object not found" } });
    expect(await readFile("kr")).toBeNull();
  });
  it("propagates failed uploads", async () => {
    mocks.upload.mockResolvedValue({ error: { message: "quota exceeded" } });
    await expect(writeFile("kr", { text: "csv", meta: {} })).rejects.toThrow("quota exceeded");
  });
  it("requires login before accessing storage", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    await expect(readFile("kr")).rejects.toThrow("로그인");
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("rejects oversized files before upload", async () => {
    await expect(writeFile("kr", { text: "x".repeat(45 * 1024 * 1024), meta: {} })).rejects.toThrow(
      "45MB",
    );
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
