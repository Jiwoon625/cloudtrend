import { expect, it, vi } from "vitest";
import { generationCachedLoader, type GenerationProbe } from "./generation-cache";
const generation = (version = "1", objectId = "object"): GenerationProbe => ({
  kind: "strong",
  objectId,
  version,
  etag: "etag",
  size: 123,
});
it("probes freshly on every cache hit and skips only validated identical generations", async () => {
  const probe = vi.fn(async () => generation());
  const loadValidated = vi.fn(async () => ({ verified: true }));
  const load = generationCachedLoader({ probe, loadValidated });
  const first = await load();
  expect(await load()).toBe(first);
  expect(probe).toHaveBeenCalledTimes(3);
  expect(loadValidated).toHaveBeenCalledTimes(1);
});
it.each([generation("2"), generation("1", "replacement")])(
  "reloads changed identity %j",
  async (changed) => {
    let current = generation();
    const loadValidated = vi.fn(async () => ({ value: 1 }));
    const load = generationCachedLoader({ probe: async () => current, loadValidated });
    const first = await load();
    current = changed;
    expect(await load()).not.toBe(first);
    expect(loadValidated).toHaveBeenCalledTimes(2);
  },
);
it.each([null, { kind: "weak" } as GenerationProbe, generation("")])(
  "never caches weak/missing generation %j",
  async (metadata) => {
    const loadValidated = vi.fn(async () => "verified");
    const load = generationCachedLoader({ probe: async () => metadata, loadValidated });
    await load();
    await load();
    expect(loadValidated).toHaveBeenCalledTimes(2);
  },
);
it("never caches a missing object", async () => {
  const loadValidated = vi.fn(async () => null);
  const load = generationCachedLoader({ probe: async () => generation(), loadValidated });
  await load();
  await load();
  expect(loadValidated).toHaveBeenCalledTimes(2);
});
it.each([generation("2"), null, { kind: "weak" } as GenerationProbe])(
  "rejects generation changes during content read %j",
  async (after) => {
    const probe = vi.fn().mockResolvedValueOnce(generation()).mockResolvedValueOnce(after);
    const load = generationCachedLoader({ probe, loadValidated: async () => "verified" });
    await expect(load()).rejects.toThrow("generation changed");
  },
);
it("does not retain old cache after a failed replacement validation", async () => {
  let current = generation(),
    fail = false;
  const loadValidated = vi.fn(async () => {
    if (fail) throw Error("invalid payload");
    return "verified";
  });
  const load = generationCachedLoader({ probe: async () => current, loadValidated });
  await load();
  current = generation("2");
  fail = true;
  await expect(load()).rejects.toThrow("invalid payload");
  current = generation();
  fail = false;
  await load();
  expect(loadValidated).toHaveBeenCalledTimes(3);
});
it("probe failure never returns cached data", async () => {
  let fail = false;
  const load = generationCachedLoader({
    probe: async () => {
      if (fail) throw Error("probe denied");
      return generation();
    },
    loadValidated: async () => "verified",
  });
  await load();
  fail = true;
  await expect(load()).rejects.toThrow("probe denied");
});
it.each([{ etag: "changed" }, { size: 124 }])(
  "reloads content metadata change %j",
  async (delta) => {
    let current = generation();
    const loadValidated = vi.fn(async () => "verified");
    const load = generationCachedLoader({ probe: async () => current, loadValidated });
    await load();
    current = { ...current!, ...delta } as GenerationProbe;
    await load();
    expect(loadValidated).toHaveBeenCalledTimes(2);
  },
);
it.each([{ etag: "" }, { size: -1 }, { size: NaN }, { size: undefined }])(
  "does not cache malformed content metadata %j",
  async (delta) => {
    const metadata = { ...generation()!, ...delta } as GenerationProbe;
    const loadValidated = vi.fn(async () => "verified");
    const load = generationCachedLoader({ probe: async () => metadata, loadValidated });
    await load();
    await load();
    expect(loadValidated).toHaveBeenCalledTimes(2);
  },
);
