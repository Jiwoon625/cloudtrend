import process from "node:process";
import { pathToFileURL } from "node:url";

const MODES = new Set(["all", "backtest", "screening"]);

export function parseCloudTrendCommand(body) {
  const tokens = String(body ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens[0] !== "/cloudtrend" || tokens[1] !== "run") {
    throw new Error("명령은 /cloudtrend run 으로 시작해야 합니다.");
  }

  const result = {
    mode: "all",
    force: false,
    roundTripCostBps: 0,
    limit: 613,
    includeEtf: false,
  };
  let modeSeen = false;
  for (const token of tokens.slice(2)) {
    if (MODES.has(token)) {
      if (modeSeen) throw new Error("실행 모드는 한 번만 지정할 수 있습니다.");
      result.mode = token;
      modeSeen = true;
    } else if (token === "force") {
      result.force = true;
    } else if (/^cost=\d+(?:\.\d+)?$/.test(token)) {
      result.roundTripCostBps = Number(token.slice(5));
      if (result.roundTripCostBps > 1000) throw new Error("cost는 0~1000bps여야 합니다.");
    } else if (/^limit=\d+$/.test(token)) {
      result.limit = Number(token.slice(6));
      if (result.limit < 1 || result.limit > 2000) throw new Error("limit은 1~2000이어야 합니다.");
    } else if (token === "include-etf") {
      result.includeEtf = true;
    } else if (token === "exclude-etf") {
      result.includeEtf = false;
    } else {
      throw new Error(`지원하지 않는 옵션입니다: ${token}`);
    }
  }
  return result;
}

function output(name, value) {
  process.stdout.write(`${name}=${String(value)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventName = process.env.EVENT_NAME ?? "issue_comment";
  const parsed =
    eventName === "workflow_dispatch"
      ? {
          mode: MODES.has(process.env.INPUT_MODE ?? "") ? process.env.INPUT_MODE : "all",
          force: process.env.INPUT_FORCE === "true",
          roundTripCostBps: Number(process.env.INPUT_COST ?? 0),
          limit: Number(process.env.INPUT_LIMIT ?? 613),
          includeEtf: process.env.INPUT_INCLUDE_ETF === "true",
        }
      : parseCloudTrendCommand(process.env.COMMENT_BODY);

  if (!MODES.has(parsed.mode))
    throw new Error("mode는 all, backtest, screening 중 하나여야 합니다.");
  if (
    !Number.isFinite(parsed.roundTripCostBps) ||
    parsed.roundTripCostBps < 0 ||
    parsed.roundTripCostBps > 1000
  )
    throw new Error("round_trip_cost_bps는 0~1000이어야 합니다.");
  if (!Number.isInteger(parsed.limit) || parsed.limit < 1 || parsed.limit > 2000)
    throw new Error("limit은 1~2000 정수여야 합니다.");

  output("mode", parsed.mode);
  output("force", parsed.force);
  output("cost", parsed.roundTripCostBps);
  output("limit", parsed.limit);
  output("include_etf", parsed.includeEtf);
}
