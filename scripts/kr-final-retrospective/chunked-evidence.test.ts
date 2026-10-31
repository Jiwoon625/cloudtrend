/* eslint-disable @typescript-eslint/no-explicit-any -- malformed synthetic transport rows */
import { randomBytes } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { appendEvidence, readEvidence, type Connection } from "./transport";
import { captureCanonicalProof } from "./capture-codec";
const owner = "11111111-1111-4111-8111-111111111111";
const prefix = "kr-final-retrospective-";
let large: any, logicalHash: string;
beforeAll(() => {
  large = {
    version: "kr-final-retrospective-capture-v1",
    synthetic: true,
    data: randomBytes(650000).toString("base64"),
  };
  logicalHash = captureCanonicalProof(large).hash;
});
function harness() {
  const rows = new Map<string, any>(),
    posts: any[] = [],
    successes: string[] = [];
  let active = 0,
    peak = 0,
    fault: { post: number; after: boolean; status?: number } | null = null;
  const connection: Connection = {
    owner,
    origin: "https://example.supabase.co",
    key: "synthetic-test-key",
    fetcher: async (url, init) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const parsed = new URL(String(url));
        expect(parsed.pathname).toBe("/rest/v1/ledger_provenance_archive");
        if (init?.method === "POST") {
          const body = String(init.body),
            row = JSON.parse(body);
          posts.push({ body, row });
          expect(row.user_id).toBe(owner);
          expect(row.source_revision).toBe("1");
          const fail = posts.length === fault?.post;
          if (fail && !fault?.after) {
            if (fault?.status)
              return new Response("synthetic gateway failure", { status: fault.status });
            throw Error("SYNTHETIC_BEFORE_COMMIT");
          }
          if (rows.has(row.source_id))
            return new Response("duplicate immutable identity", { status: 409 });
          rows.set(row.source_id, structuredClone(row));
          successes.push(row.source_id);
          if (fail && fault?.after) {
            if (fault.status)
              return new Response("synthetic gateway failure", { status: fault.status });
            throw Error("SYNTHETIC_AFTER_COMMIT");
          }
          return new Response(null, { status: 201 });
        }
        expect(init?.method).toBe("GET");
        expect(parsed.searchParams.get("user_id")).toBe("eq." + owner);
        expect(parsed.searchParams.get("source_revision")).toBe("eq.1");
        const id = parsed.searchParams.get("source_id")!.slice(3);
        return new Response(JSON.stringify(rows.has(id) ? [rows.get(id)] : []));
      } finally {
        active--;
      }
    },
  };
  return {
    connection,
    rows,
    posts,
    successes,
    peak: () => peak,
    fault: (value: typeof fault) => {
      fault = value;
    },
  };
}
const rootId = () => prefix + "capture:" + logicalHash.slice(7);
const chunkRows = (f: ReturnType<typeof harness>) =>
  [...f.rows.values()].filter(
    (r) => r.payload.version === "kr-final-retrospective-evidence-chunk-v1",
  );
function mutateRoot(f: ReturnType<typeof harness>, change: (payload: any) => void) {
  const row = f.rows.get(rootId());
  change(row.payload);
  row.source_hash = captureCanonicalProof(row.payload).hash;
}
it("preserves full logical proof through serial bounded chunk INSERTs then verified root", async () => {
  const f = harness();
  const result = await appendEvidence(f.connection, "capture", large);
  expect(result.hash).toBe(logicalHash);
  expect(await readEvidence(f.connection, "capture", logicalHash)).toEqual(large);
  const root = f.rows.get(rootId());
  expect(root.payload.version).toBe("kr-final-retrospective-evidence-manifest-v1");
  expect(chunkRows(f).length).toBeGreaterThan(1);
  expect(f.posts.at(-1)!.row.source_id).toBe(rootId());
  expect(f.peak()).toBe(1);
  for (const { body, row } of f.posts) {
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(307200);
    expect(captureCanonicalProof(row.payload).hash).toBe(row.source_hash);
  }
  for (const row of chunkRows(f)) {
    expect(row.source_id).toBe(prefix + "chunk:" + row.source_hash.slice(7));
    expect(row.payload.hash).toBe(logicalHash);
    expect(row.payload.data.length).toBeLessThanOrEqual(262144);
  }
  const count = f.posts.length;
  expect((await appendEvidence(f.connection, "capture", large)).hash).toBe(logicalHash);
  expect(f.posts).toHaveLength(count);
});
it("retains small legacy gzip-envelope behavior and raw historical read compatibility", async () => {
  const f = harness(),
    small = { synthetic: true, data: [1, 2, 3] };
  const result = await appendEvidence(f.connection, "capture", small);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0].row.payload.version).toBe("kr-final-retrospective-evidence-gzip-v1");
  expect(await readEvidence(f.connection, "capture", result.hash)).toEqual(small);
  const raw = { synthetic: "historical raw" },
    hash = captureCanonicalProof(raw).hash;
  f.rows.set(prefix + "capture:" + hash.slice(7), {
    user_id: owner,
    source_revision: "1",
    source_id: prefix + "capture:" + hash.slice(7),
    source_hash: hash,
    payload: raw,
  });
  expect(await readEvidence(f.connection, "capture", hash)).toEqual(raw);
});
it.each([
  "corruption",
  "missing",
  "duplicate",
  "reordered",
  "wrong-index",
  "wrong-owner",
  "oversize-count",
  "encoded-length",
  "envelope-hash",
])("rejects %s chunked evidence", async (kind) => {
  const f = harness();
  await appendEvidence(f.connection, "capture", large);
  const chunks = chunkRows(f);
  if (kind === "corruption") chunks[0].payload.data = "AAAA" + chunks[0].payload.data.slice(4);
  if (kind === "missing") f.rows.delete(chunks[0].source_id);
  if (kind === "duplicate")
    mutateRoot(f, (p) => {
      p.chunks[1] = p.chunks[0];
    });
  if (kind === "reordered")
    mutateRoot(f, (p) => {
      p.chunks.reverse();
    });
  if (kind === "wrong-index") {
    chunks[0].payload.index = 999;
    chunks[0].source_hash = captureCanonicalProof(chunks[0].payload).hash;
  }
  if (kind === "wrong-owner") chunks[0].user_id = "22222222-2222-4222-8222-222222222222";
  if (kind === "oversize-count")
    mutateRoot(f, (p) => {
      p.chunks = Array(257).fill(p.chunks[0]);
    });
  if (kind === "encoded-length")
    mutateRoot(f, (p) => {
      p.encodedLength += 4;
    });
  if (kind === "envelope-hash")
    mutateRoot(f, (p) => {
      p.envelopeHash = "sha256:" + "f".repeat(64);
    });
  await expect(readEvidence(f.connection, "capture", logicalHash)).rejects.toThrow();
});
it.each([1, 2, 3])(
  "stops after uncertain committed chunk %i; explicit later append resumes without duplicates",
  async (post) => {
    const f = harness();
    f.fault({ post, after: true });
    await expect(appendEvidence(f.connection, "capture", large)).rejects.toThrow(
      /EVIDENCE_APPEND_SERVER_UNHEALTHY/,
    );
    expect(f.posts).toHaveLength(post);
    expect(f.successes).toHaveLength(post);
    expect(f.rows.has(rootId())).toBe(false);
    f.fault(null);
    expect((await appendEvidence(f.connection, "capture", large)).hash).toBe(logicalHash);
    expect(new Set(f.successes).size).toBe(f.successes.length);
    expect(f.posts.length).toBe(f.successes.length);
    expect(await readEvidence(f.connection, "capture", logicalHash)).toEqual(large);
  },
);
it.each([1, 2, 3])(
  "failed pre-commit chunk %i blocks root; later exact replay resumes without duplicate committed chunks",
  async (post) => {
    const f = harness();
    f.fault({ post, after: false });
    await expect(appendEvidence(f.connection, "capture", large)).rejects.toThrow();
    expect(f.rows.has(rootId())).toBe(false);
    expect(f.posts).toHaveLength(post);
    expect(f.successes).toHaveLength(post - 1);
    f.fault(null);
    expect((await appendEvidence(f.connection, "capture", large)).hash).toBe(logicalHash);
    expect(new Set(f.successes).size).toBe(f.successes.length);
    expect(await readEvidence(f.connection, "capture", logicalHash)).toEqual(large);
  },
);
it("rejects conflicting preexisting immutable chunk without replacing it or writing root", async () => {
  const f = harness();
  f.fault({ post: 2, after: false });
  await expect(appendEvidence(f.connection, "capture", large)).rejects.toThrow();
  const row = chunkRows(f)[0];
  row.payload.data = "AAAA";
  const original = structuredClone(row),
    posts = f.posts.length;
  f.fault(null);
  await expect(appendEvidence(f.connection, "capture", large)).rejects.toThrow();
  expect(f.posts).toHaveLength(posts);
  expect(f.rows.get(row.source_id)).toEqual(original);
  expect(f.rows.has(rootId())).toBe(false);
});
it("root manifest is not trusted until every chunk has been independently verified", async () => {
  const f = harness();
  await appendEvidence(f.connection, "capture", large);
  const row = chunkRows(f)[0];
  f.rows.delete(row.source_id);
  await expect(readEvidence(f.connection, "capture", logicalHash)).rejects.toThrow();
});

it("stops after uncertain committed root; explicit later append confirms without another INSERT", async () => {
  const first = harness();
  await appendEvidence(first.connection, "capture", large);
  const f = harness();
  f.fault({ post: first.posts.length, after: true });
  await expect(appendEvidence(f.connection, "capture", large)).rejects.toThrow(
    /EVIDENCE_APPEND_SERVER_UNHEALTHY/,
  );
  expect(f.posts).toHaveLength(first.posts.length);
  expect(f.rows.has(rootId())).toBe(true);
  f.fault(null);
  expect((await appendEvidence(f.connection, "capture", large)).hash).toBe(logicalHash);
  expect(f.posts).toHaveLength(first.posts.length);
  expect(f.successes).toHaveLength(first.posts.length);
  expect(await readEvidence(f.connection, "capture", logicalHash)).toEqual(large);
});
it("rejects a conflicting preexisting root without replacing it", async () => {
  const f = harness();
  await appendEvidence(f.connection, "capture", large);
  mutateRoot(f, (p) => {
    p.bytes += 1;
  });
  const root = structuredClone(f.rows.get(rootId())),
    posts = f.posts.length;
  await expect(appendEvidence(f.connection, "capture", large)).rejects.toThrow();
  expect(f.posts).toHaveLength(posts);
  expect(f.rows.get(rootId())).toEqual(root);
});
it("rejects declarations beyond the encoded payload bound before fetching chunks", async () => {
  const f = harness();
  await appendEvidence(f.connection, "capture", large);
  mutateRoot(f, (p) => {
    p.encodedLength = 64 * 1024 * 1024 + 4;
  });
  await expect(readEvidence(f.connection, "capture", logicalHash)).rejects.toThrow();
});
it("rejects a fully rehashed chunk with the wrong positional index", async () => {
  const f = harness();
  await appendEvidence(f.connection, "capture", large);
  const chunk = chunkRows(f)[0],
    oldId = chunk.source_id;
  chunk.payload.index = 1;
  chunk.source_hash = captureCanonicalProof(chunk.payload).hash;
  chunk.source_id = prefix + "chunk:" + chunk.source_hash.slice(7);
  f.rows.delete(oldId);
  f.rows.set(chunk.source_id, chunk);
  mutateRoot(f, (p) => {
    p.chunks[0] = chunk.source_hash;
  });
  await expect(readEvidence(f.connection, "capture", logicalHash)).rejects.toThrow();
});

it.each(["root-owner", "root-revision", "chunk-revision"])(
  "rejects persisted %s identity mismatch",
  async (kind) => {
    const f = harness();
    await appendEvidence(f.connection, "capture", large);
    if (kind === "root-owner")
      f.rows.get(rootId()).user_id = "22222222-2222-4222-8222-222222222222";
    if (kind === "root-revision") f.rows.get(rootId()).source_revision = "2";
    if (kind === "chunk-revision") chunkRows(f)[0].source_revision = "2";
    await expect(readEvidence(f.connection, "capture", logicalHash)).rejects.toThrow();
  },
);
it("returned HTTP520 before commit stops after one attempt with no root publication", async () => {
  const f = harness();
  f.fault({ post: 2, after: false, status: 520 });
  await expect(appendEvidence(f.connection, "capture", large)).rejects.toThrow(/520/);
  expect(f.posts).toHaveLength(2);
  expect(f.successes).toHaveLength(1);
  expect(f.rows.has(rootId())).toBe(false);
});
it.each([520, 429])(
  "returned HTTP%s after commit stops all writes until explicit later identical append",
  async (status) => {
    const f = harness();
    f.fault({ post: 2, after: true, status });
    await expect(appendEvidence(f.connection, "capture", large)).rejects.toThrow(
      /EVIDENCE_APPEND_SERVER_UNHEALTHY/,
    );
    expect(f.posts).toHaveLength(2);
    expect(f.successes).toHaveLength(2);
    expect(f.rows.has(rootId())).toBe(false);
    f.fault(null);
    expect((await appendEvidence(f.connection, "capture", large)).hash).toBe(logicalHash);
    expect(f.posts.length).toBe(f.successes.length);
    expect(new Set(f.successes).size).toBe(f.successes.length);
    expect(await readEvidence(f.connection, "capture", logicalHash)).toEqual(large);
  },
);
it("root precommit failure leaves only verified chunks and exact retry publishes root once", async () => {
  const reference = harness();
  await appendEvidence(reference.connection, "capture", large);
  const f = harness();
  f.fault({ post: reference.posts.length, after: false, status: 520 });
  await expect(appendEvidence(f.connection, "capture", large)).rejects.toThrow(/520/);
  expect(f.rows.has(rootId())).toBe(false);
  expect(f.successes.length).toBe(reference.posts.length - 1);
  f.fault(null);
  expect((await appendEvidence(f.connection, "capture", large)).hash).toBe(logicalHash);
  expect(f.successes.length).toBe(reference.posts.length);
  expect(new Set(f.successes).size).toBe(f.successes.length);
  expect(f.posts.length).toBe(reference.posts.length + 1);
});
