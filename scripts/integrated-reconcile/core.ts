/** Separate downstream completion check. Never scores raw inputs or rewrites a completed day. */
export type Market = "KR" | "US";
export interface HistoricalLineageProof {
  proofHash: string;
  date: string;
  checkpointThrough: string;
  stageHash: string;
  stageSourceHash: string;
  modelSourceHash: string;
}
export interface Snapshot {
  heads: { O1: string | null; S07: string | null };
  models: Record<string, { complete: boolean; sourceHash: string | null }>;
  evidence: Record<
    string,
    {
      status: "STORED" | "OUTBOX" | "MISSING";
      hash: string | null;
      sourceHash: string | null;
      decisionAt: string | null;
      historicalLineage?: HistoricalLineageProof;
    }
  >;
  fingerprint: string;
}
export interface ReconcilePort {
  dates: string[];
  due(date: string): Market[];
  inspect(): Promise<Snapshot>;
  restore(market: Market, date: string, hash: string): Promise<void>;
  replay(throughDate: string): Promise<{ recorded: number; waiting: string | null }>;
}
export interface Finding {
  date: string;
  market: Market;
  reason: "MISSING_PREPARED_EVIDENCE" | "WAITING_MARKET_PUBLICATION" | "WAITING_DECISION";
}
export interface Report {
  status: "COMPLETE" | "READY" | "WAITING" | "REPAIR_REQUIRED";
  throughDate: string;
  readyThrough: string | null;
  heads: Snapshot["heads"];
  findings: Finding[];
  recoverableInputs: number;
  restoredInputs: number;
  recorded: number;
}
const key = (m: Market, d: string) => `${m}:${d}`;
function validDate(d: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    Number.isFinite(Date.parse(`${d}T00:00:00Z`)) &&
    new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d
  );
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
export function inspectCompletion(
  port: Pick<ReconcilePort, "dates" | "due">,
  s: Snapshot,
  now: string,
): Report {
  check(Number.isFinite(Date.parse(now)), "Invalid observation clock");
  check(port.dates.length > 0 && port.dates.length <= 260, "Unsupported reconciliation range");
  check(
    port.dates.every((d, i) => validDate(d) && d >= "2026-10-12" && (!i || d > port.dates[i - 1])),
    "Unordered session calendar",
  );
  check(/^sha256:[a-f0-9]{64}$/.test(s.fingerprint), "Unverified snapshot fingerprint");
  for (const h of Object.values(s.heads))
    check(h === null || validDate(h), "Invalid integrated head");
  const findings: Finding[] = [];
  let readyThrough: string | null = null,
    prefixReady = true,
    recoverableInputs = 0;
  for (const date of port.dates) {
    const due = port.due(date);
    check(
      due.length > 0 &&
        due.length <= 2 &&
        new Set(due).size === due.length &&
        due.every((m) => m === "KR" || m === "US"),
      "Invalid due-market calendar",
    );
    let ready = true;
    for (const market of due) {
      const id = key(market, date),
        model = s.models[id],
        evidence = s.evidence[id];
      check(model && evidence, "Incomplete inspection coverage");
      if (evidence.status !== "MISSING") {
        check(
          /^sha256:[a-f0-9]{64}$/.test(evidence.hash ?? "") &&
            /^sha256:[a-f0-9]{64}$/.test(evidence.sourceHash ?? "") &&
            Number.isFinite(Date.parse(evidence.decisionAt ?? "")),
          "Invalid prepared evidence",
        );
        if (model.complete && model.sourceHash !== evidence.sourceHash) {
          const proof = evidence.historicalLineage;
          check(
            market === "KR" &&
              evidence.status === "STORED" &&
              proof &&
              /^sha256:[a-f0-9]{64}$/.test(proof.proofHash) &&
              proof.date === date &&
              validDate(proof.checkpointThrough) &&
              proof.stageHash === evidence.hash &&
              proof.stageSourceHash === evidence.sourceHash &&
              proof.modelSourceHash === model.sourceHash &&
              date <= proof.checkpointThrough &&
              Object.values(s.heads).every((h) => h !== null && proof.checkpointThrough <= h),
            "Market/evidence source conflict",
          );
        }
      }
      if (!model.complete) {
        findings.push({ date, market, reason: "WAITING_MARKET_PUBLICATION" });
        ready = false;
      } else if (evidence.status === "MISSING") {
        findings.push({ date, market, reason: "MISSING_PREPARED_EVIDENCE" });
        ready = false;
      } else if (Date.parse(evidence.decisionAt!) > Date.parse(now)) {
        findings.push({ date, market, reason: "WAITING_DECISION" });
        ready = false;
      } else if (evidence.status === "OUTBOX") recoverableInputs++;
    }
    prefixReady = prefixReady && ready;
    if (prefixReady) readyThrough = date;
  }
  const throughDate = port.dates.at(-1)!;
  const missing = findings.some((f) => f.reason === "MISSING_PREPARED_EVIDENCE");
  const allRecorded = Object.values(s.heads).every((h) => h !== null && h >= throughDate);
  return {
    status: missing
      ? "REPAIR_REQUIRED"
      : findings.length
        ? "WAITING"
        : allRecorded && !recoverableInputs
          ? "COMPLETE"
          : "READY",
    throughDate,
    readyThrough,
    heads: s.heads,
    findings,
    recoverableInputs,
    restoredInputs: 0,
    recorded: 0,
  };
}
export async function reconcile(
  port: ReconcilePort,
  options: { now: string; apply: boolean },
): Promise<Report> {
  let state = await port.inspect();
  const first = inspectCompletion(port, state, options.now);
  if (!options.apply || first.status === "COMPLETE") return first;
  // Hard holes are never silently skipped or guessed from today's raw sources.
  if (first.status === "REPAIR_REQUIRED") return first;
  let restoredInputs = 0;
  for (const date of port.dates)
    for (const market of port.due(date)) {
      const id = key(market, date),
        item = state.evidence[id];
      if (
        item.status !== "OUTBOX" ||
        !state.models[id].complete ||
        Date.parse(item.decisionAt!) > Date.parse(options.now)
      )
        continue;
      const fresh = await port.inspect();
      check(
        fresh.fingerprint === state.fingerprint,
        "Concurrent change before input restoration; inspect again",
      );
      await port.restore(market, date, item.hash!);
      state = await port.inspect();
      check(
        state.evidence[id].status === "STORED" && state.evidence[id].hash === item.hash,
        "Restored input readback mismatch",
      );
      // Each restored exact input is resumable; uncertain writes are not retried in this invocation.
      inspectCompletion(port, state, options.now);
      restoredInputs++;
    }
  const ready = inspectCompletion(port, state, options.now);
  let recorded = 0;
  if (
    ready.readyThrough &&
    Object.values(state.heads).some((h) => h === null || h < ready.readyThrough!)
  ) {
    const fresh = await port.inspect();
    check(
      fresh.fingerprint === state.fingerprint,
      "Concurrent change before integrated replay; inspect again",
    );
    const result = await port.replay(ready.readyThrough);
    check(
      result.waiting === null,
      "Integrated replay stopped; inspect exact committed prefix before retry",
    );
    recorded = result.recorded;
    state = await port.inspect();
    check(
      Object.values(state.heads).every((h) => h !== null && h >= ready.readyThrough!),
      "Integrated publication readback incomplete",
    );
  }
  const final = inspectCompletion(port, state, options.now);
  return { ...final, restoredInputs, recorded };
}
