/* eslint-disable @typescript-eslint/no-explicit-any -- intentional malformed-schema synthetic fault cases */
/** Synthetic adapter tests. Engine outputs are genuine, storage is isolated memory only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyApprovedModelPlan } from "./apply-model-plan";
import { createRecoveryMemoryStore } from "./ordered-plan";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import {
  recoveryFixture,
  harness,
  clone,
  same,
  sessionKey,
  repin,
  H,
} from "./recovery-model-plan-fixture";

test("VALIDATE authentic twelve-session plan performs zero writes", async () => {
  const h = await harness(await recoveryFixture());
  h.input.phase = "VALIDATE";
  assert.equal((await applyApprovedModelPlan(h.input)).status, "EXACT_MODEL_PLAN_VALIDATED");
  assert.deepEqual(h.attempts, []);
  assert.deepEqual(h.commits, []);
  h.assertOriginal();
  assert.equal(h.checks().inventoryChecks, 1);
  assert.equal(h.checks().actualChecks, 1);
});
test("fresh application, exact retry and immutable full original prefixes", async () => {
  const f = await recoveryFixture(),
    h = await harness(f);
  assert.equal((await applyApprovedModelPlan(h.input)).status, "EXACT_MODEL_PLAN_APPLIED");
  h.assertComplete();
  h.assertOriginal();
  assert.equal(h.attempts.length, 18);
  const before = clone([...h.data.sessions]);
  const count = h.attempts.length;
  await applyApprovedModelPlan(h.input);
  h.assertComplete();
  h.assertOriginal();
  assert(same([...h.data.sessions], before));
  assert(
    h.attempts.slice(count).every((k) => !k.startsWith("adopted-") && !k.startsWith("integrated:")),
  );
});

for (const mode of ["BEFORE", "AFTER"] as const)
  for (let boundary = 1; boundary <= 18; boundary++)
    test(`${mode} interruption at mutation boundary ${boundary}/18 stops, then exact retry completes`, async () => {
      const h = await harness(await recoveryFixture());
      h.setFault({ at: boundary, mode });
      await assert.rejects(applyApprovedModelPlan(h.input), /SYNTHETIC_/);
      assert.equal(h.attempts.length, boundary);
      assert.equal(h.commits.length, boundary - (mode === "BEFORE" ? 1 : 0));
      h.assertOriginal();
      const committedBefore = clone([...h.data.sessions]);
      h.clearFault();
      await applyApprovedModelPlan(h.input);
      h.assertComplete();
      h.assertOriginal();
      for (const [key, v] of committedBefore) assert(same(h.data.sessions.get(key), v));
    });
for (const boundary of [1, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18])
  test(`lost readback after boundary ${boundary} never guesses outcome; exact retry resumes`, async () => {
    const h = await harness(await recoveryFixture());
    h.setFault({ at: boundary, mode: "READBACK" });
    await assert.rejects(applyApprovedModelPlan(h.input), /SYNTHETIC_READBACK_LOST/);
    assert.equal(h.attempts.length, boundary);
    assert.equal(h.commits.length, boundary);
    h.assertOriginal();
    h.clearFault();
    await applyApprovedModelPlan(h.input);
    h.assertComplete();
    h.assertOriginal();
  });

const malformed: Array<[string, (h: Awaited<ReturnType<typeof harness>>) => void | Promise<void>]> =
  [
    [
      "authoritative approval digest",
      (h) => {
        h.input.authoritativeApprovalHash = H("f");
      },
    ],
    [
      "authoritative plan digest",
      (h) => {
        h.input.authoritativePlanHash = H("f");
      },
    ],
    [
      "owner",
      (h) => {
        h.input.owner = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      },
    ],
    [
      "runtime",
      (h) => {
        h.input.runtimeHashes.october = H("f");
      },
    ],
    [
      "approval status",
      async (h) => {
        (h.input.approval as any).status = "PENDING";
        h.input.authoritativeApprovalHash = await hashSeriesValue(h.input.approval);
      },
    ],
    [
      "authority receipt without authoritative registry",
      async (h) => {
        h.input.plan.models.retrospectiveAuthorityCandidate.receipt.captureManifestHash = H("b");
        await repin(h);
      },
    ],
    [
      "unknown target archive date",
      async (h) => {
        h.input.plan.models.newKrArchives[0].date = "2026-10-28";
        await repin(h);
      },
    ],
    [
      "reordered target archives",
      async (h) => {
        h.input.plan.models.newKrArchives.reverse();
        await repin(h);
      },
    ],
    [
      "duplicated target archive",
      async (h) => {
        h.input.plan.models.newKrArchives[1] = clone(h.input.plan.models.newKrArchives[0]);
        await repin(h);
      },
    ],
    [
      "missing prepared book",
      async (h) => {
        h.input.plan.models.preparedPublications[0].entries.pop();
        await repin(h);
      },
    ],
    [
      "new adopted outputs differ from prepared outputs",
      async (h) => {
        h.input.plan.models.newAdoptedSessions = clone(h.input.plan.models.newAdoptedSessions);
        h.input.plan.models.newAdoptedSessions[0].receipt.date = "2026-10-28";
        await repin(h);
      },
    ],
    [
      "forged execution provenance output",
      async (h) => {
        h.input.plan.executionProvenance.newModelStates[0].stateHash = H("b");
        h.input.authoritativePlanHash = await hashSeriesValue(h.input.plan);
        h.input.approval.fullPlanHash = h.input.authoritativePlanHash;
        h.input.approval.executionProvenanceHash = await hashSeriesValue(
          h.input.plan.executionProvenance,
        );
        h.input.authoritativeApprovalHash = await hashSeriesValue(h.input.approval);
      },
    ],
    [
      "reordered integrated kinds",
      async (h) => {
        h.input.plan.models.newIntegratedSessions.reverse();
        await repin(h);
      },
    ],
    [
      "unknown existing target archive",
      (h) => {
        const a = clone(h.input.plan.models.newKrArchives[0]);
        a.inputs.markets.UNKNOWN = "KOSDAQ";
        h.data.archives.set(a.date + ":" + H("f"), a);
      },
    ],
    [
      "unknown existing prepared object",
      (h) => {
        const p = clone(h.input.plan.models.preparedPublications[0]);
        p.sourceHash = H("f");
        h.data.prepared.set("KR:" + p.date, p);
      },
    ],
    [
      "retained integrated evidence changed",
      (h) => {
        h.evidence.get("2026-10-26")!.payload.synthetic = "changed";
      },
    ],
    [
      "candidate next evidence hash",
      async (h) => {
        h.input.plan.integratedNextEvidence.payload.synthetic = "changed";
        await repin(h);
      },
    ],
    [
      "unrecognized phase",
      (h) => {
        (h.input as any).phase = "MAYBE";
      },
    ],
  ];
for (const [name, edit] of malformed)
  test(`malformed ${name} fails before every mutation`, async () => {
    const h = await harness(await recoveryFixture());
    await edit(h);
    await assert.rejects(applyApprovedModelPlan(h.input));
    assert.deepEqual(h.attempts, []);
    assert.deepEqual(h.commits, []);
  });
for (const index of [0, 1, 2, 3, 4])
  test(`book ${index} noncontiguous 27 with missing26 rejects before writes`, async () => {
    const h = await harness(await recoveryFixture()),
      run = h.input.plan.models.preparedPublications[1].entries[index].run;
    h.data.sessions.set(sessionKey(run.bookId, run.receipt.date), clone(run));
    await assert.rejects(applyApprovedModelPlan(h.input));
    assert.deepEqual(h.attempts, []);
    h.assertOriginal();
  });
for (const kind of ["O1", "S07"] as const)
  test(`integrated ${kind} missing original26 cannot be disguised by exact latest27`, async () => {
    const h = await harness(await recoveryFixture()),
      run = h.input.plan.models.newIntegratedSessions.find(
        (x: any) => x.registry.policy.kind === kind,
      );
    h.integrated.delete(kind + ":2026-10-26");
    h.integrated.set(kind + ":2026-10-27", clone(run));
    await assert.rejects(applyApprovedModelPlan(h.input));
    assert.deepEqual(h.attempts, []);
  });
test("existing adopted26 tamper is rejected even with a valid27 prepared plan", async () => {
  const h = await harness(await recoveryFixture()),
    run = clone(h.input.plan.models.preparedPublications[0].entries[0].run);
  run.result.syntheticTamper = true;
  h.data.sessions.set(sessionKey(run.bookId, run.receipt.date), run);
  await assert.rejects(applyApprovedModelPlan(h.input));
  assert.deepEqual(h.attempts, []);
  h.assertOriginal();
});
test("existing integrated26 tamper is rejected before writes", async () => {
  const h = await harness(await recoveryFixture());
  (h.integrated.get("O1:2026-10-26")! as any).result.syntheticTamper = true;
  await assert.rejects(applyApprovedModelPlan(h.input));
  assert.deepEqual(h.attempts, []);
});

test("memory store authentic predecessors, complete two-date plan, exact retry and reference isolation", async () => {
  const f = await recoveryFixture(),
    predecessors = await Promise.all(
      f.predecessors.map(async (p) => ({
        ...p,
        payloadHash: await hashSeriesValue(p.run),
      })),
    ),
    archives = await Promise.all(
      [...f.original.archives.values()].map(async (payload) => ({
        payload,
        hash: await hashSeriesValue(payload),
      })),
    );
  const memory = await createRecoveryMemoryStore({ predecessors, archives });
  const original = clone(predecessors);
  predecessors[0]!.run.publication.sourceHash = H("f");
  assert(same(await memory.store.readLatest(original[0]!.series.bookId), original[0]!.run));
  const returned = await memory.store.readLatest<any>(original[0]!.series.bookId);
  returned.publication.sourceHash = H("f");
  assert(same(await memory.store.readLatest(original[0]!.series.bookId), original[0]!.run));
  for (const a of f.plan.models.newKrArchives) await memory.store.putKrInput(a);
  for (const p of f.plan.models.preparedPublications) {
    await memory.store.prepare(p);
    for (const e of p.entries) {
      const previous = await memory.store.readSession<any>(e.series.bookId, e.previousDate);
      await memory.store.append(e.series, e.run, previous);
    }
  }
  assert.equal(memory.appended.length, 10);
  assert.equal(memory.prepared.size, 2);
  assert.equal(memory.newArchives.length, 2);
  memory.assertPrefix();
  for (const p of f.plan.models.preparedPublications) {
    await memory.store.prepare(p);
    for (const e of p.entries)
      assert.equal(
        (
          await memory.store.append(
            e.series,
            e.run,
            await memory.store.readSession<any>(e.series.bookId, e.previousDate),
          )
        ).reused,
        true,
      );
  }
  assert.equal(memory.appended.length, 10);
  memory.assertPrefix();
  await assert.rejects(memory.store.insertSeries(original[0]!.series));
});
for (const mutation of [
  "duplicate predecessor",
  "bad payload hash",
  "bad state hash",
  "duplicate archive",
  "bad archive hash",
] as const)
  test(`memory store rejects ${mutation} without an external writer`, async () => {
    const f = await recoveryFixture(),
      predecessors = await Promise.all(
        f.predecessors.map(async (p) => ({
          ...p,
          payloadHash: await hashSeriesValue(p.run),
        })),
      ),
      archives = await Promise.all(
        [...f.original.archives.values()].map(async (payload) => ({
          payload,
          hash: await hashSeriesValue(payload),
        })),
      );
    if (mutation === "duplicate predecessor") predecessors.push(clone(predecessors[0]!));
    if (mutation === "bad payload hash") predecessors[0]!.payloadHash = H("f");
    if (mutation === "bad state hash") predecessors[0]!.run.stateHash = H("f");
    if (mutation === "duplicate archive") archives.push(clone(archives[0]!));
    if (mutation === "bad archive hash") archives[0]!.hash = H("f");
    await assert.rejects(createRecoveryMemoryStore({ predecessors, archives }));
  });

test("a newly self-hashed foreign retrospective authority cannot stand behind the old registry pin", async () => {
  const h = await harness(await recoveryFixture()),
    a = h.input.plan.models.retrospectiveAuthorityCandidate;
  a.receipt.owner = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  a.registry.receiptHash = await hashSeriesValue(a.receipt);
  a.authoritativeRegistryHash = await hashSeriesValue(a.registry);
  await repin(h);
  await assert.rejects(applyApprovedModelPlan(h.input));
  assert.deepEqual(h.attempts, []);
});

test("known-date archive content not linked to prepared runs is rejected before writes", async () => {
  const h = await harness(await recoveryFixture());
  h.input.plan.models.newKrArchives[0].inputs.markets.UNKNOWN = "KOSDAQ";
  await repin(h);
  await assert.rejects(applyApprovedModelPlan(h.input));
  assert.deepEqual(h.attempts, []);
});
test("memory store cannot skip missing26 by passing original23 as previous for a genuine27 run", async () => {
  const f = await recoveryFixture(),
    predecessors = await Promise.all(
      f.predecessors.map(async (p) => ({
        ...p,
        payloadHash: await hashSeriesValue(p.run),
      })),
    ),
    archives = await Promise.all(
      [...f.original.archives.values()].map(async (payload) => ({
        payload,
        hash: await hashSeriesValue(payload),
      })),
    );
  const memory = await createRecoveryMemoryStore({ predecessors, archives });
  const e = f.plan.models.preparedPublications[1].entries[0];
  await assert.rejects(memory.store.append(e.series, e.run, predecessors[0]!.run));
  assert.equal(memory.appended.length, 0);
  memory.assertPrefix();
});

for (const guard of ["inventory", "actual-ledger", "source-read"] as const)
  test(`failed ${guard} admission cannot produce a mutation`, async () => {
    const h = await harness(await recoveryFixture());
    if (guard === "inventory")
      h.input.assertArtifactInventory = async () => {
        throw new Error("SYNTHETIC_INVENTORY_CONFLICT");
      };
    if (guard === "actual-ledger")
      h.input.assertActualLedgersUnchanged = async () => {
        throw new Error("SYNTHETIC_ACTUAL_REVISION_CHANGED");
      };
    if (guard === "source-read")
      h.input.integrated.readSession = async () => {
        throw new Error("SYNTHETIC_READ_UNAVAILABLE");
      };
    await assert.rejects(applyApprovedModelPlan(h.input), /SYNTHETIC_/);
    assert.deepEqual(h.attempts, []);
    h.assertOriginal();
  });

test("memory prepared hashes and immutable same-date prepared conflicts are enforced", async () => {
  const f = await recoveryFixture(),
    predecessors = await Promise.all(
      f.predecessors.map(async (p) => ({
        ...p,
        payloadHash: await hashSeriesValue(p.run),
      })),
    ),
    archives = await Promise.all(
      [...f.original.archives.values()].map(async (payload) => ({
        payload,
        hash: await hashSeriesValue(payload),
      })),
    );
  const memory = await createRecoveryMemoryStore({ predecessors, archives }),
    p = clone(f.plan.models.preparedPublications[0]);
  p.sourceHash = H("f");
  await assert.rejects(memory.store.prepare(p));
  assert.equal(memory.prepared.size, 0);
  const original = f.plan.models.preparedPublications[0];
  await memory.store.prepare(original);
  const { preparedHash: _old, ...body } = p;
  p.preparedHash = await hashSeriesValue(body);
  await assert.rejects(memory.store.prepare(p));
  assert.equal(memory.prepared.size, 1);
  assert(same(await memory.store.readPrepared("KR", original.date), original));
  memory.assertPrefix();
});

for (const index of [0, 1, 2, 3, 4])
  test(`book ${index} exact26 session with stale23 latest projection rejects before writes`, async () => {
    const f = await recoveryFixture(),
      h = await harness(f),
      entry = f.plan.models.preparedPublications[0].entries[index];
    h.data.sessions.set(sessionKey(entry.series.bookId, entry.run.receipt.date), clone(entry.run));
    const original = f.predecessors.find((p) => p.series.bookId === entry.series.bookId)!.run,
      readLatest = h.input.store.readLatest;
    h.input.store.readLatest = async <T>(id: string) =>
      (id === entry.series.bookId ? clone(original) : readLatest(id)) as Promise<T | null>;
    await assert.rejects(applyApprovedModelPlan(h.input));
    assert.deepEqual(h.attempts, []);
    h.assertOriginal();
  });
