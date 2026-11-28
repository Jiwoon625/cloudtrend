// Phase 1: isolated, read-only master adapter and candidate projection.
// Not wired to production; no ledger or screening writes. See cutover document.
function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value;
}

function day(value, label, max) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`Invalid ${label}`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value || value > max)
    throw new Error(`Invalid ${label}`);
  return value;
}

function readMasterPage(page, config) {
  const p = requireRecord(page, "page");
  if (
    p.object !== "page" ||
    p.archived === true ||
    p.in_trash === true ||
    typeof p.id !== "string" ||
    !p.id
  )
    throw new Error("Invalid page identity");
  const props = requireRecord(p.properties, "properties");
  const prop = (name, type) => {
    const x = requireRecord(props[name], name);
    if (x.type !== type) throw new Error(`Unexpected property type: ${name}`);
    return x[type];
  };
  const text = (name, type) => {
    const list = prop(name, type);
    if (!Array.isArray(list) || !list.length || list.some((x) => typeof x?.plain_text !== "string"))
      throw new Error(`Missing ${name}`);
    const value = list
      .map((x) => x.plain_text)
      .join("")
      .trim();
    if (!value) throw new Error(`Empty ${name}`);
    return value;
  };
  const select = (name) => {
    const x = prop(name, "select");
    if (typeof x?.name !== "string") throw new Error(`Missing ${name}`);
    return x.name;
  };
  const number = (name) => {
    const f = prop(name, "formula");
    if (
      f?.type !== "number" ||
      typeof f.number !== "number" ||
      !Number.isFinite(f.number) ||
      f.number < 0
    )
      throw new Error(`Unverified numeric formula: ${name}`);
    return f.number;
  };
  const date = (name, max) => {
    const x = prop(name, "date");
    if (x === null) return null;
    if (!x || x.end != null || x.time_zone != null)
      throw new Error(`Invalid date property: ${name}`);
    return day(x.start, name, max);
  };
  const owners = prop("사람", "people");
  if (
    !Array.isArray(owners) ||
    owners.length !== 1 ||
    owners[0]?.id !== config.notionPersonId ||
    props["사람"].has_more === true
  )
    throw new Error("Owner mismatch");
  const relation = prop("거래내역", "relation");
  // Notion documents a 25-reference formula/rollup limitation. Reject possible truncation rather than treat it as zero.
  if (!Array.isArray(relation) || relation.length >= 25 || props["거래내역"].has_more === true)
    throw new Error("Unverified relation completeness");
  const name = text("종목명", "title"),
    symbol = text("종목코드", "rich_text");
  const listing = select("시장"),
    currency = select("통화"),
    assetType = select("종목구분");
  if (!["KOSPI", "KOSDAQ", "미국"].includes(listing) || !["주식", "ETF"].includes(assetType))
    throw new Error("Unknown market or asset type");
  const market = listing === "미국" ? "US" : assetType === "ETF" ? "ETF" : listing;
  if (
    listing === "미국"
      ? currency !== "USD" || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(symbol)
      : currency !== "KRW" || !/^[0-9A-Z]{6}$/.test(symbol)
  )
    throw new Error("Invalid symbol or trading currency");
  const max = listing === "미국" ? config.usDate : config.krDate;
  const quantity = number("보유수량");
  const average = quantity > 0 ? number("보유주식 평단가") : null;
  const amount = quantity > 0 ? number("보유금액") : null;
  if (quantity > 0 && (average <= 0 || amount <= 0))
    throw new Error("Invalid positive holding basis");
  const firstEntryDate = date("보유시작일", max),
    lastSellDate = date("최근매도일", max);
  if (quantity > 0 && !firstEntryDate) throw new Error("Missing holding start");
  // A trading currency is not proof of the Notion cost currency. Never compare an unverified basis to quotes.
  const basisCurrency =
    currency === "KRW" && config.krBasisVerified === true
      ? "KRW"
      : currency === "USD" && config.usBasisVerified === true
        ? "USD"
        : null;
  return {
    sourcePageId: p.id,
    key: `${market}:${symbol}`,
    name,
    symbol,
    market,
    listing,
    assetType,
    currency,
    quantity,
    reportedAverage: average,
    reportedAmount: amount,
    basisCurrency,
    firstEntryDate,
    lastSellDate,
  };
}

function buildMasterSnapshot(pages, config) {
  if (!config.notionPersonId || typeof config.notionPersonId !== "string")
    throw new Error("Owner configuration missing");
  day(config.krDate, "KR date", "9999-12-31");
  day(config.usDate, "US date", "9999-12-31");
  if (typeof config.syncedAt !== "string" || !Number.isFinite(Date.parse(config.syncedAt)))
    throw new Error("Invalid sync time");
  if (!Array.isArray(pages) || !pages.length)
    throw new Error("Empty source cannot replace holdings");
  const records = pages.map((p) => readMasterPage(p, config));
  if (
    new Set(records.map((p) => p.key)).size !== records.length ||
    new Set(records.map((p) => p.sourcePageId)).size !== records.length
  )
    throw new Error("Duplicate holding identity");
  // Catch the same listed domestic ticker classified as both stock and ETF.
  if (
    new Set(records.map((p) => `${p.listing === "미국" ? "US" : "KR"}:${p.symbol}`)).size !==
    records.length
  )
    throw new Error("Conflicting security classification");
  records.sort((a, b) => a.key.localeCompare(b.key));
  return {
    version: "notion-master-v1",
    syncedAt: config.syncedAt,
    krDate: config.krDate,
    usDate: config.usDate,
    records: records.filter((p) => p.quantity > 0),
    recentSells: records
      .filter((p) => p.lastSellDate !== null)
      .map((p) => ({ key: p.key, date: p.lastSellDate })),
    missingSellEvidence: records.filter((p) => p.lastSellDate === null).map((p) => p.key),
  };
}

async function readMasterPages({
  authenticatedOwnerId,
  ownerId,
  notionPersonId,
  sourceId,
  token,
  fetchImpl = fetch,
}) {
  if (
    typeof ownerId !== "string" ||
    !ownerId ||
    authenticatedOwnerId !== ownerId ||
    typeof notionPersonId !== "string" ||
    !notionPersonId
  )
    throw new Error("Owner authorization required");
  if (
    typeof sourceId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(sourceId) ||
    typeof token !== "string" ||
    !token
  )
    throw new Error("Notion configuration missing");
  const pages = [],
    seen = new Set();
  let cursor;
  do {
    if (seen.size >= 1000) throw new Error("Pagination bound exceeded");
    if (cursor) {
      if (seen.has(cursor)) throw new Error("Repeated Notion cursor");
      seen.add(cursor);
    }
    const response = await fetchImpl(`https://api.notion.com/v1/data_sources/${sourceId}/query`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 100,
        filter: { property: "사람", people: { contains: notionPersonId } },
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Notion query failed (${response.status})`);
    const data = await response.json();
    if (
      data?.object !== "list" ||
      !Array.isArray(data.results) ||
      typeof data.has_more !== "boolean"
    )
      throw new Error("Malformed Notion list");
    pages.push(...data.results);
    if (data.has_more && (typeof data.next_cursor !== "string" || !data.next_cursor))
      throw new Error("Incomplete Notion pagination");
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function classifyRawCandidates(snapshot, signals, options) {
  // This is a projection only, not a replacement for the existing strategy engines.
  const held = new Set(snapshot?.records?.map((p) => p.key) ?? []);
  const usable =
    options?.snapshotVerified === true &&
    options?.fresh === true &&
    snapshot?.version === "notion-master-v1";
  return signals.map((signal) => {
    const key = `${signal.market}:${signal.symbol}`;
    // Preserve input observations even if portfolio evidence is absent.
    const entry = signal.entry === true;
    const exit = signal.exit === true;
    const position = usable ? (held.has(key) ? "HELD" : "NOT_HELD") : "UNKNOWN";
    return {
      signal,
      position,
      entryCandidate: entry
        ? position === "UNKNOWN"
          ? "PENDING"
          : position === "HELD"
            ? "NO"
            : "CANDIDATE"
        : "NO",
      exitCandidate: exit
        ? position === "UNKNOWN"
          ? "PENDING"
          : position === "HELD"
            ? "CANDIDATE"
            : "NO"
        : "NO",
    };
  });
}

export { buildMasterSnapshot, readMasterPages, classifyRawCandidates };
