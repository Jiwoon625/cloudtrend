const header =
  "date,symbol,name,open,high,low,close,volume,ret120,ret252,beta60_spy,ichimoku_tk_gap,relvol1_20,adv20_usd,amihud20,active20,toss_tradable,is_common_share";
export const sourceCsv = (date: string) =>
  `${header}\n${date},SPY,SPY,100,102,99,101,10000,0.1,0.2,1,0.1,1,10000000,0.0001,true,true,false\n${date},TEST,TEST,10,12,9,11,1000,0.2,0.3,1.1,0.2,1.5,1000000,0.0002,true,true,true\n`;

/** Same atomic universe, with only TEST's reviewed lifecycle exclusion applied. */
export const reviewedSourceCsv = (date: string) => {
  const rows = sourceCsv(date)
    .trimEnd()
    .split("\n")
    .map((row) => row.split(","));
  rows[0]!.push("status");
  rows[1]!.push("");
  rows[2]!.push("SUSPENDED");
  for (const key of [
    "open",
    "high",
    "low",
    "close",
    "volume",
    "ret120",
    "ret252",
    "beta60_spy",
    "ichimoku_tk_gap",
    "relvol1_20",
    "adv20_usd",
    "amihud20",
  ])
    rows[2]![rows[0]!.indexOf(key)] = "";
  for (const key of ["active20", "toss_tradable"]) rows[2]![rows[0]!.indexOf(key)] = "false";
  return rows.map((row) => row.join(",")).join("\n") + "\n";
};
