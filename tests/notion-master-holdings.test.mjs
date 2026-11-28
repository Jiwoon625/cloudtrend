import {
  buildMasterSnapshot,
  readMasterPages,
  classifyRawCandidates,
} from "../src/lib/notionMasterHoldings.mjs";

function fixture({
  id = "p1",
  symbol = "000001",
  listing = "KOSPI",
  assetType = "주식",
  currency = "KRW",
  quantity = 3,
  average = 100,
  amount = 300,
  start = "2026-11-01",
  sell = null,
  owner = "person",
  relations = [],
} = {}) {
  const val = (type, v) => ({ type, [type]: v });
  return {
    object: "page",
    id,
    properties: {
      종목명: val("title", [{ plain_text: "Synthetic" }]),
      종목코드: val("rich_text", [{ plain_text: symbol }]),
      사람: val("people", [{ id: owner }]),
      거래내역: val("relation", relations),
      시장: val("select", { name: listing }),
      종목구분: val("select", { name: assetType }),
      통화: val("select", { name: currency }),
      보유수량: val("formula", { type: "number", number: quantity }),
      "보유주식 평단가": val("formula", { type: "number", number: average }),
      보유금액: val("formula", { type: "number", number: amount }),
      보유시작일: val("date", start ? { start, end: null, time_zone: null } : null),
      최근매도일: val("date", sell ? { start: sell, end: null, time_zone: null } : null),
    },
  };
}

async function regressionSuite() {
  const cfg = {
    notionPersonId: "person",
    krDate: "2026-11-28",
    usDate: "2026-11-27",
    syncedAt: "2026-11-28T00:00:00Z",
    krBasisVerified: true,
  };
  let passed = 0;
  function ok(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
  }
  function rejects(fn, message) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    ok(threw, message);
  }
  async function rejectsAsync(fn, message) {
    let threw = false;
    try {
      await fn();
    } catch {
      threw = true;
    }
    ok(threw, message);
  }
  const pages = [
    fixture(),
    fixture({ id: "p2", symbol: "0046A0", assetType: "ETF" }),
    fixture({
      id: "p3",
      symbol: "VOO",
      listing: "미국",
      currency: "USD",
      assetType: "ETF",
      quantity: 0.5,
    }),
    fixture({
      id: "p4",
      symbol: "000002",
      quantity: 0,
      average: null,
      amount: null,
      start: null,
      sell: "2026-11-20",
    }),
  ];
  const s = buildMasterSnapshot(pages, cfg);
  ok(s.records.length === 3, "zero quantity excluded");
  ok(
    s.records.some((p) => p.key === "ETF:0046A0"),
    "alphanumeric ETF",
  );
  ok(
    s.records.some((p) => p.key === "KOSPI:000001"),
    "leading zero",
  );
  ok(
    s.records.some((p) => p.key === "US:VOO" && p.quantity === 0.5 && p.basisCurrency === null),
    "US ETF fractional and unverified basis",
  );
  ok(
    s.recentSells.some((p) => p.key === "KOSPI:000002"),
    "sold security retains date",
  );
  ok(s.missingSellEvidence.includes("KOSPI:000001"), "blank recent sell evidence distinguished");
  ok(
    buildMasterSnapshot([fixture({ quantity: 0, start: null })], cfg).records.length === 0,
    "verified zero holdings",
  );
  rejects(() => buildMasterSnapshot([], cfg), "empty fetch rejected");
  rejects(() => buildMasterSnapshot([fixture({ quantity: null })], cfg), "null not zero");
  rejects(() => buildMasterSnapshot([fixture({ quantity: -1 })], cfg), "negative holdings");
  rejects(() => buildMasterSnapshot([fixture({ owner: "other" })], cfg), "wrong owner");
  rejects(() => buildMasterSnapshot([fixture({ start: null })], cfg), "missing active cycle");
  rejects(
    () => buildMasterSnapshot([fixture({ start: "2026-02-30" })], cfg),
    "invalid calendar day",
  );
  rejects(() => buildMasterSnapshot([fixture({ start: "2026-11-29" })], cfg), "future date");
  rejects(
    () => buildMasterSnapshot([fixture({ listing: "미국", symbol: "VOO", currency: "KRW" })], cfg),
    "wrong currency",
  );
  rejects(
    () => buildMasterSnapshot([fixture(), fixture({ id: "p9" })], cfg),
    "duplicate market symbol",
  );
  rejects(
    () => buildMasterSnapshot([fixture(), fixture({ id: "p9", assetType: "ETF" })], cfg),
    "conflicting classifications",
  );
  rejects(
    () => buildMasterSnapshot([fixture({ relations: Array(25).fill({ id: "t" }) })], cfg),
    "possible truncated relation",
  );
  const inputs = [
    { market: "KOSPI", symbol: "000001", entry: true, exit: true },
    { market: "KOSPI", symbol: "000002", entry: true, exit: true },
  ];
  const before = JSON.stringify(inputs);
  const out = classifyRawCandidates(s, inputs, { snapshotVerified: true, fresh: true });
  ok(out[0].entryCandidate === "NO" && out[0].exitCandidate === "CANDIDATE", "held candidate");
  ok(out[1].entryCandidate === "CANDIDATE" && out[1].exitCandidate === "NO", "unheld candidate");
  ok(JSON.stringify(inputs) === before && out[0].signal === inputs[0], "raw signals untouched");
  ok(
    classifyRawCandidates(s, inputs, { snapshotVerified: true, fresh: false }).every(
      (x) => x.entryCandidate === "PENDING" && x.exitCandidate === "PENDING",
    ),
    "stale evidence fail closed",
  );
  ok(
    classifyRawCandidates(null, inputs, { snapshotVerified: true, fresh: true }).every(
      (x) => x.position === "UNKNOWN",
    ),
    "missing snapshot not empty",
  );
  const auth = {
    authenticatedOwnerId: "owner",
    ownerId: "owner",
    notionPersonId: "person",
    sourceId: "12345678-1234-1234-1234-123456789012",
    token: "synthetic",
  };
  let requests = 0;
  const fetched = await readMasterPages({
    ...auth,
    fetchImpl: async (url, init) => {
      requests++;
      const body = JSON.parse(init.body);
      ok(
        url.startsWith("https://api.notion.com/") && body.filter.people.contains === "person",
        "fixed host and owner filter",
      );
      if (requests === 1)
        return {
          ok: true,
          json: async () => ({
            object: "list",
            results: [pages[0]],
            has_more: true,
            next_cursor: "next",
          }),
        };
      ok(body.start_cursor === "next", "cursor forwarded");
      return {
        ok: true,
        json: async () => ({
          object: "list",
          results: [pages[1]],
          has_more: false,
          next_cursor: null,
        }),
      };
    },
  });
  ok(requests === 2 && fetched.length === 2, "complete pagination");
  await rejectsAsync(
    () =>
      readMasterPages({
        ...auth,
        authenticatedOwnerId: "other",
        fetchImpl: async () => {
          throw new Error("must not call");
        },
      }),
    "unauthorized request",
  );
  await rejectsAsync(
    () =>
      readMasterPages({
        ...auth,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ object: "list", results: [], has_more: true, next_cursor: null }),
        }),
      }),
    "missing cursor",
  );
  await rejectsAsync(
    () =>
      readMasterPages({
        ...auth,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            object: "list",
            results: [],
            has_more: true,
            next_cursor: "repeat",
          }),
        }),
      }),
    "repeated cursor",
  );
  await rejectsAsync(
    () => readMasterPages({ ...auth, fetchImpl: async () => ({ ok: false, status: 429 }) }),
    "API failure",
  );
  return passed;
}

console.log(`Notion master holdings: ${await regressionSuite()} checks passed`);
