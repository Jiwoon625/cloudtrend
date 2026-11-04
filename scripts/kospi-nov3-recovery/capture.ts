/* eslint-disable @typescript-eslint/no-explicit-any -- hashed owner-private source evidence */
import fs from "node:fs";
import path from "node:path";
import {
  reader,
  snapshot,
  legacyInventory,
  readEvidence,
  type Connection,
} from "../kr-final-retrospective/transport";
import {
  captureCanonicalChunks,
  captureCanonicalProof,
} from "../kr-final-retrospective/capture-codec";

import {
  classifyKrScreeningPublication,
  unresolvedKrPendingSources,
} from "../../src/lib/krScreeningPublication";

const H = (v: unknown) => captureCanonicalProof(v).hash;

const need = (v: unknown) => {
  if (!v) throw Error("NOV3_CAPTURE_REJECTED");
};
export const NOV3_PRIOR_REFS = {
  capsuleHash: "sha256:7b4f3d5a2984e4091b7d6a01211ade5d8877c3f1f737b3d1030848845f4ccfcc",
  planHash: "sha256:aafc077261a8679574f7abce520516dea36efe835da0d75a789dcb4adba05057",
  approvalHash: "sha256:c32a5bd7cfaca0e04612d2f7dc53736e7f676ee43c7b2d7373bfb0ef5e045f9a",
  completionHash: "sha256:b12096b28b1923b0159f9a6fe8c312ff3dbbc56b131ae484e9ca39052ee45f55",
};
export function savePrivate(file: string, value: unknown) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    for (const b of captureCanonicalChunks(value)) fs.writeSync(fd, b);
  } finally {
    fs.closeSync(fd);
  }
}
export async function loadPriorNovember(o: Connection) {
  const refs = NOV3_PRIOR_REFS,
    c = await readEvidence(o, "execution", refs.capsuleHash);
  need(c.version === "kospi-november-recovery-capsule-v1" && c.owner === o.owner);
  const old = c.priorRecoveryRefs;
  need(
    old.planHash === "sha256:2964685f4dcf1ea6d237c4101525458dae110260d85dea73185b45f7e12f02d9" &&
      old.approvalHash ===
        "sha256:cf64e1e10834278d23477f5643b5a5fde4e5f4cb69966e01c8ccb46598d5a6e5" &&
      old.completionHash ===
        "sha256:c2049440924da0dedf2a3de6459cf49e47eae878cf64fe928df7ce355f0072a6",
  );
  const priorRecovery = {
    plan: { hash: old.planHash, payload: await readEvidence(o, "plan", old.planHash) },
    approval: {
      hash: old.approvalHash,
      payload: await readEvidence(o, "approval", old.approvalHash),
    },
    completion: {
      hash: old.completionHash,
      payload: await readEvidence(o, "completion", old.completionHash),
    },
  };
  const receipt = {
    version: "kospi-november-recovery-preparation-v1",
    kind: "RECOVERY_PREPARATION_ONLY",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    input: { ...c.input, priorRecovery },
    result: c.result,
  };
  need(H(receipt) === refs.planHash);
  need(
    receipt.input.authority.runtimeCodeHash ===
      "sha256:55dcf41767160a6b507422447ee6a4818b34a41a55205128086bbce6d058c990" &&
      receipt.result.authority.runtimeCodeHash === receipt.input.authority.runtimeCodeHash,
  );
  return {
    plan: { hash: refs.planHash, payload: receipt },
    approval: {
      hash: refs.approvalHash,
      payload: await readEvidence(o, "execution", refs.approvalHash),
    },
    completion: {
      hash: refs.completionHash,
      payload: await readEvidence(o, "execution", refs.completionHash),
    },
  };
}
/** No ledger writes. Source bytes live only in the runner's private ephemeral directory. */
export async function captureNov3(
  o: Connection,
  dir: string,
  codeVersion: string,
  sourceConnection: () => Connection,
) {
  need(/^[a-f0-9]{40}$/.test(codeVersion));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, "sources"), { mode: 0o700 });
  const baseline = await snapshot(o),
    rows = baseline.sources;
  const publication = classifyKrScreeningPublication(rows);
  need(
    publication.phase === "FINAL" &&
      publication.asOfDate === "2026-11-03" &&
      unresolvedKrPendingSources(rows).length === 0,
  );
  const r = reader(o);
  const archiveRows = await r.rows(
    "ledger_provenance_archive",
    { source_id: "like.october-input:KR:*", source_revision: "eq.1" },
    513,
    "source_id.asc",
  );
  const preparedRows = await r.rows(
    "ledger_provenance_archive",
    { source_id: "like.october-prepared:*", source_revision: "eq.1" },
    513,
    "source_id.asc",
  );
  const vintageRows = await r.rows(
    "shadow_replay_audit",
    { market: "eq.KR", strategy_version: "in.(reviewed-kr-vintage-v1,reviewed-kr-vintage-v2)" },
    129,
    "id.asc",
  );
  const paths = await legacyInventory(o),
    root = `${o.owner}/shadow/kospi-confirm1-bear-rsaccel-v1/revisions/october14-retrospective-v1`;
  need(
    !paths.includes(root + "/sessions/2026-11-03.json") &&
      paths.includes(root + "/sessions/2026-11-02.json"),
  );
  const priorRecovery = await loadPriorNovember(o);
  const capturedObjects: any[] = [],
    generationPins: any[] = [],
    sourceObjectPins: any[] = [];
  for (const p of paths) {
    const x = await reader(o).object(p);
    const payload = JSON.parse(x.bytes.toString());
    capturedObjects.push({ path: p, hash: H(payload), payload });
    generationPins.push({ path: p, hash: H(payload), generation: x.generation });
  }
  let sourceBytes = 0;
  for (const r of rows) {
    need(
      r.user_id === o.owner &&
        r.source_type === "screening" &&
        r.status === "active" &&
        r.storage_bucket === "cloudtrend-data" &&
        /^[a-f0-9-]{36}$/.test(r.id) &&
        r.storage_path.startsWith(o.owner + "/source/screening/"),
    );
    // Separate bounded read-only transport per source; total metadata bound before bytes transfer.
    const read = reader(sourceConnection());
    const info = await read.info(r.storage_path);
    const size = Number(info.size);
    need(Number.isSafeInteger(size) && size > 0 && size <= 80 * 1024 * 1024);
    sourceBytes += size;
    need(sourceBytes <= 384 * 1024 * 1024);
    const x = await read.object(r.storage_path, r.file_hash);
    need(x.bytes.length === size);
    fs.writeFileSync(path.join(dir, "sources", r.id), x.bytes, { mode: 0o600, flag: "wx" });
    sourceObjectPins.push({ path: r.storage_path, hash: r.file_hash, generation: x.generation });
  }
  need(H(await snapshot(o)) === H(baseline) && H(await legacyInventory(o)) === H(paths));
  need(
    H(
      await r.rows(
        "ledger_provenance_archive",
        { source_id: "like.october-input:KR:*", source_revision: "eq.1" },
        513,
        "source_id.asc",
      ),
    ) === H(archiveRows),
  );
  need(
    H(
      await r.rows(
        "ledger_provenance_archive",
        { source_id: "like.october-prepared:*", source_revision: "eq.1" },
        513,
        "source_id.asc",
      ),
    ) === H(preparedRows),
  );
  need(
    H(
      await r.rows(
        "shadow_replay_audit",
        { market: "eq.KR", strategy_version: "in.(reviewed-kr-vintage-v1,reviewed-kr-vintage-v2)" },
        129,
        "id.asc",
      ),
    ) === H(vintageRows),
  );
  savePrivate(path.join(dir, "capture.json"), {
    version: "kospi-nov3-readonly-capture-v1",
    owner: o.owner,
    codeVersion,
    capturedAt: new Date().toISOString(),
    baseline,
    archiveRows,
    preparedRows,
    vintageRows,
    sourceRows: rows,
    sourceObjectPins,
    capturedObjects,
    generationPins,
    priorRecovery,
    sourceBytes,
    publication,
    historicalAvailabilityClaim: false,
  });
  return {
    status: "CAPTURED",
    sourceCount: rows.length,
    sourceBytes,
    journalCount: paths.length,
    historicalAvailabilityClaim: false,
  };
}
