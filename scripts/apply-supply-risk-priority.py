from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    if text.count(old) != 1:
        raise SystemExit(f"pattern not unique in {path}: {text.count(old)} matches")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "src/lib/engine/types.ts",
    "  foreignNetBuyValue: number | null;\n  institutionNetBuyValue: number | null;\n",
    "  foreignNetBuyValue: number | null;\n  institutionNetBuyValue: number | null;\n  /** 공매도 거래량 비중(%). 공급자가 제공하지 않으면 null/undefined */\n  shortSellingVolumeRate?: number | null;\n  /** 대차잔고 수량. 공급자가 제공하지 않으면 null/undefined */\n  lendingBalanceQuantity?: number | null;\n",
)

replace_once(
    "src/lib/engine/manualDataset.ts",
    '  institutionnetbuyvalue: "institutionNetBuyValue",\n  institutionnet: "institutionNetBuyValue",\n  기관순매수: "institutionNetBuyValue",\n  sector: "sector",\n',
    '  institutionnetbuyvalue: "institutionNetBuyValue",\n  institutionnet: "institutionNetBuyValue",\n  기관순매수: "institutionNetBuyValue",\n  shortsellingvolumerate: "shortSellingVolumeRate",\n  공매도거래량비중: "shortSellingVolumeRate",\n  lendingbalancequantity: "lendingBalanceQuantity",\n  대차잔고수량: "lendingBalanceQuantity",\n  sector: "sector",\n',
)
replace_once(
    "src/lib/engine/manualDataset.ts",
    '      foreignNetBuyValue: num(pick(rec, "foreignNetBuyValue")),\n      institutionNetBuyValue: num(pick(rec, "institutionNetBuyValue")),\n    };\n',
    '      foreignNetBuyValue: num(pick(rec, "foreignNetBuyValue")),\n      institutionNetBuyValue: num(pick(rec, "institutionNetBuyValue")),\n      shortSellingVolumeRate: num(pick(rec, "shortSellingVolumeRate")),\n      lendingBalanceQuantity: num(pick(rec, "lendingBalanceQuantity")),\n    };\n',
)

replace_once(
    "src/lib/engine/indicators.ts",
    "  foreignNet60d: number | null;\n  institutionNet20d: number | null;\n  extensionFromMa20: number | null; // %\n",
    "  foreignNet60d: number | null;\n  institutionNet20d: number | null;\n  /** 현재 공매도 거래량 비중 - 20거래일 전 비중 (%p) */\n  shortSellingVolumeRate20dChangePp?: number | null;\n  /** 현재 대차잔고 수량 - 20거래일 전 수량 */\n  lendingBalanceQuantity20dChange?: number | null;\n  extensionFromMa20: number | null; // %\n",
)
replace_once(
    "src/lib/engine/indicators.ts",
    "function sumLast(values: Array<number | null>, endIndex: number, n: number): number | null {\n  if (endIndex - n + 1 < 0) return null;\n  let s = 0;\n  for (let i = endIndex - n + 1; i <= endIndex; i++) {\n    const v = values[i];\n    if (v === null || v === undefined) return null;\n    s += v;\n  }\n  return s;\n}\n\nexport function computeIndicators",
    "function sumLast(values: Array<number | null>, endIndex: number, n: number): number | null {\n  if (endIndex - n + 1 < 0) return null;\n  let s = 0;\n  for (let i = endIndex - n + 1; i <= endIndex; i++) {\n    const v = values[i];\n    if (v === null || v === undefined) return null;\n    s += v;\n  }\n  return s;\n}\n\nfunction changeFromLookback(\n  values: Array<number | null>,\n  endIndex: number,\n  lookback: number,\n): number | null {\n  const current = values[endIndex];\n  const prior = values[endIndex - lookback];\n  if (current === null || current === undefined || prior === null || prior === undefined) return null;\n  if (!Number.isFinite(current) || !Number.isFinite(prior)) return null;\n  return current - prior;\n}\n\nexport function computeIndicators",
)
replace_once(
    "src/lib/engine/indicators.ts",
    "  const foreign = bars.map((b) => b.foreignNetBuyValue);\n  const inst = bars.map((b) => b.institutionNetBuyValue);\n",
    "  const foreign = bars.map((b) => b.foreignNetBuyValue);\n  const inst = bars.map((b) => b.institutionNetBuyValue);\n  const shortSellingVolumeRates = bars.map((b) => b.shortSellingVolumeRate ?? null);\n  const lendingBalanceQuantities = bars.map((b) => b.lendingBalanceQuantity ?? null);\n",
)
replace_once(
    "src/lib/engine/indicators.ts",
    "    foreignNet60d: sumLast(foreign, endIndex, 60),\n    institutionNet20d: sumLast(inst, endIndex, 20),\n    extensionFromMa20: ma20 !== null && ma20 !== 0 ? (close / ma20 - 1) * 100 : null,\n",
    "    foreignNet60d: sumLast(foreign, endIndex, 60),\n    institutionNet20d: sumLast(inst, endIndex, 20),\n    shortSellingVolumeRate20dChangePp: changeFromLookback(shortSellingVolumeRates, endIndex, 20),\n    lendingBalanceQuantity20dChange: changeFromLookback(lendingBalanceQuantities, endIndex, 20),\n    extensionFromMa20: ma20 !== null && ma20 !== 0 ? (close / ma20 - 1) * 100 : null,\n",
)

replace_once(
    "src/lib/engine/pipeline.ts",
    "    const rotationScore = rotationScoreBySector.get(inst.sectorCode) ?? null;\n    const priority = buildPriorityScoreV8(legacyPriority, rotationScore);\n",
    "    const rotationScore = rotationScoreBySector.get(inst.sectorCode) ?? null;\n    const priority = buildPriorityScoreV8(\n      legacyPriority,\n      rotationScore,\n      inst.instrumentType === \"STOCK\"\n        ? {\n            shortSellingVolumeRate20dChangePp: snap.shortSellingVolumeRate20dChangePp ?? null,\n            lendingBalanceQuantity20dChange: snap.lendingBalanceQuantity20dChange ?? null,\n          }\n        : null,\n    );\n",
)
