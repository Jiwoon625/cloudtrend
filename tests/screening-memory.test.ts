import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  validateSourceBytes,
  CANONICAL_SOURCE_COLUMNS,
  sourceRowKey,
  toCanonicalCsv,
} from "../src/lib/sourceData";
import {
  canonicalMergedCsv,
  persistWebScreeningCaches,
} from "../scripts/web-screening-cache-store";
import {
  loadAnalysisSourceInputs,
  type LoadedSourceInput,
  type SourceRecord,
} from "../scripts/source-registry-store";
import {
  screeningJsonChunks,
  writeScreeningJson,
  uploadScreeningJsonFile,
} from "../scripts/screening-json-file";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { deterministicAnalysis } from "../src/lib/screeningCacheContract";
import { buildSnapshot } from "../src/lib/screeningSnapshot";

const csv = `symbol,name,market,type,date,open,high,low,close,volume,sector,foreignNetBuyValue,etfNav\n005930,"삼성,전자",KOSPI,STOCK,2026-09-01,10,11,9,10,100,TECH,3,\n490590,"ETF\n커버드콜",ETF,ETF,2026-09-01,10,11,9,10,100,ETC,,10\n`;
async function validate(text: string, streamingCsv = false, filename = "source.csv") {
  return validateSourceBytes({ bytes: new TextEncoder().encode(text), filename, streamingCsv });
}
for (const [label, text, filename] of [
  ["quoted multiline 102-column normalization", csv, "source.csv"],
  ["BOM and tabs", "\uFEFF종목코드\t일자\t종가\nA005930\t20260901\t10\n", "source.csv"],
  ["identical duplicates", csv + csv.split("\n")[1] + "\n", "source.csv"],
  [
    "conflicting duplicates",
    csv + "005930,other,KOSPI,STOCK,2026-09-01,10,11,9,11,100,TECH,3,\n",
    "source.csv",
  ],
  ["invalid price and date", "symbol,date,close\n005930,20260231,-1\n", "source.csv"],
  ["header only", "symbol,date,close\n", "source.csv"],
  ["empty", "", "source.csv"],
  ["malformed quotes", 'symbol,date,close\n"005930,20260901,10', "source.csv"],
  [
    "JSON fallback",
    JSON.stringify([{ symbol: "005930", date: "20260901", close: 10 }]),
    "source.json",
  ],
] as const) {
  test(`streaming validator exactly matches legacy: ${label}`, async () => {
    expect(await validate(text, true, filename)).toEqual(await validate(text, false, filename));
  });
}
function loaded(validation: Awaited<ReturnType<typeof validate>>, id: string): LoadedSourceInput {
  return {
    id,
    fileName: "source.csv",
    bytes: validation.originalSizeBytes,
    savedAt: "2026-09-30T00:00:00Z",
    text: validation.canonicalCsv,
    fileHash: validation.fileHash,
    dataHash: validation.dataHash,
    schemaHash: validation.schemaHash,
    sourceRecord: null,
    validation,
  };
}
test("compact raw cache preserves all 102 columns, insertion order, latest-source whole-row wins and empty output", async () => {
  const a = loaded(await validate(csv), "a");
  const b = loaded(await validate(csv.replace("100,TECH,3", "200,TECH,")), "b");
  const expected = new Map();
  for (const input of [a, b])
    for (const row of input.validation.rows) expected.set(sourceRowKey(row), row);
  a.validation.rows = [];
  b.validation.rows = [];
  expect(canonicalMergedCsv([a, b])).toBe(toCanonicalCsv([...expected.values()]));
  expect(canonicalMergedCsv([])).toBe(toCanonicalCsv([]));
});
test("compact registry retains hash verification and activation order while releasing normalized rows", async () => {
  const validations = [
    await validate(csv),
    await validate(csv.replace("100,TECH,3", "200,TECH,3")),
  ];
  const files = [csv, csv.replace("100,TECH,3", "200,TECH,3")];
  const records = validations.map(
    (v, i) =>
      ({
        id: String(i),
        original_filename: "source.csv",
        canonical_format: "csv",
        storage_bucket: "bucket",
        storage_path: String(i),
        file_hash: v.fileHash,
        data_hash: v.dataHash,
        schema_hash: v.schemaHash,
        activated_at: String(i),
        validation_result: {},
      }) as SourceRecord,
  );
  let active = 0,
    peak = 0;
  const download = vi.fn(async (key: string) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { error: null, data: new Blob([files[Number(key)]!]) };
  });
  const chain: any = {};
  for (const method of ["select", "eq", "in", "order"]) chain[method] = () => chain;
  chain.then = (resolve: any) => Promise.resolve({ data: records, error: null }).then(resolve);
  const client = { from: () => chain, storage: { from: () => ({ download }) } } as any;
  const inputs = await loadAnalysisSourceInputs(client, "user", "screening", { compact: true });
  expect(peak).toBe(1);
  expect(inputs.map((i) => i.id)).toEqual(["0", "1"]);
  expect(inputs.map((i) => i.text)).toEqual(validations.map((v) => v.canonicalCsv));
  expect(inputs.every((i) => i.validation.rows.length === 0)).toBe(true);
  records[0]!.data_hash = "sha256:wrong";
  await expect(
    loadAnalysisSourceInputs(client, "user", "screening", { compact: true }),
  ).rejects.toThrow("해시 불일치");
});
test("streamed bundle keeps native JSON values and uploads the existing single object path", async () => {
  const bundle = {
    schemaVersion: 1,
    run: { id: "run", unused: undefined },
    config: {},
    summary: { total: 20000 },
    result: {
      rows: Array.from({ length: 20000 }, (_, i) => ({
        i,
        text: '한글\n"x"',
        nullable: null,
        missing: undefined,
      })),
      sparse: [undefined, NaN, Infinity],
      time: new Date("2026-09-30"),
    },
  };
  expect([...screeningJsonChunks(bundle)].join("")).toBe(JSON.stringify(bundle));
  const dir = await mkdtemp(path.join(tmpdir(), "screening-json-"));
  try {
    const file = path.join(dir, "bundle.json");
    await writeScreeningJson(file, bundle);
    let actual = "";
    const upload = vi.fn(async (_path, stream) => {
      for await (const chunk of stream) actual += chunk.toString();
      return { error: null };
    });
    const client = { storage: { from: () => ({ upload }) } } as any;
    const result = await uploadScreeningJsonFile(client, "user/results/screening/run.json", file);
    expect(actual).toBe(await readFile(file, "utf8"));
    expect(JSON.parse(actual)).toEqual(JSON.parse(JSON.stringify(bundle)));
    expect(result.bytes).toBe(Buffer.byteLength(actual));
    expect(upload.mock.calls[0]![0]).toBe("user/results/screening/run.json");
    expect(upload.mock.calls[0]![1].destroyed).toBe(true);
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("legacy and compact normalization yield identical full analysis, candidates, summary-cache digest and round trip", async () => {
  const lines = [
    "symbol,name,market,type,date,close,volume,marketCap,foreignNetBuyValue,institutionNetBuyValue,sector",
  ];
  for (let i = 0; i < 100; i++) {
    const date = new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10);
    lines.push(`KOSPI,코스피,INDEX,INDEX,${date},${2000 + i},0,,,,MARKET_IDX`);
    for (const [symbol, name, market, type, sector] of [
      ["005930", "삼성전자", "KOSPI", "STOCK", "TECH"],
      ["490590", "ETF", "ETF", "ETF", "ETC"],
      ["472150", "ETF2", "ETF", "ETF", "ETC"],
    ])
      lines.push(
        `${symbol},${name},${market},${type},${date},${10000 + i * 20},1000000,10000000000000,100000,100000,${sector}`,
      );
  }
  const text = lines.join("\n");
  const a = await validate(text),
    b = await validate(text, true);
  const legacy = runFullMarketAnalysis(parseManualMarketData(a.canonicalCsv).dataset);
  const compact = runFullMarketAnalysis(parseManualMarketData(b.canonicalCsv).dataset);
  expect(deterministicAnalysis(compact.analysis)).toEqual(deterministicAnalysis(legacy.analysis));
  const files = new Map<string, string>();
  const storage = {
    upload: async (key: string, body: string) => {
      files.set(key, body);
      return { error: null };
    },
    download: async (key: string) =>
      files.has(key)
        ? { data: new Blob([files.get(key)!]), error: null }
        : { data: null, error: { message: "Object not found" } },
  };
  const client = { storage: { from: () => storage } } as any;
  const base = { client, userId: "user", config: DEFAULT_SCORING_CONFIG, previous: null };
  const first = await persistWebScreeningCaches({
    ...base,
    inputs: [loaded(a, "a")],
    analysis: legacy.analysis,
    snapshot: buildSnapshot(legacy.analysis),
  });
  const input = loaded(b, "a");
  input.validation.rows = [];
  const second = await persistWebScreeningCaches({
    ...base,
    inputs: [input],
    analysis: compact.analysis,
    snapshot: buildSnapshot(compact.analysis),
  });
  expect(second.inputFingerprint).toBe(first.inputFingerprint);
  expect(second.resultDigest).toBe(first.resultDigest);
  expect(second.regressionMatched).toBe(true);
  expect(second.roundTripVerified).toBe(true);
  expect(files.has("user/raw/screening/latest.csv")).toBe(true);
  expect(files.has("user/cache/dashboard/latest.json")).toBe(true);
  expect(JSON.parse(files.get("user/kr.json")!).meta.chars).toBe(b.canonicalCsv.length);
});
