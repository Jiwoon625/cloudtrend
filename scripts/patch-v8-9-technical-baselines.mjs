import fs from "node:fs";

const path = "src/lib/engine/v8SupplyFeatureValidation.ts";
let text = fs.readFileSync(path, "utf8");

function replaceOnce(from, to, label) {
  if (!text.includes(from)) throw new Error(`V8-9 baseline patch target not found: ${label}`);
  text = text.replace(from, to);
}

replaceOnce(
`function standardizedBeta(
  observations: RegressionObservation[],
  targetY: "yRaw" | "yExcess",
  extraNames: string[] = [],
) {
  if (observations.length < 20) return null;
  const predictorNames = ["TARGET", ...extraNames, ...V8_VF_FEATURE_IDS] as string[];`,
`function standardizedBeta(
  observations: RegressionObservation[],
  targetY: "yRaw" | "yExcess",
  extraNames: string[] = [],
  controlNames: readonly VfFeatureId[] = V8_VF_FEATURE_IDS,
) {
  if (observations.length < 20) return null;
  const predictorNames = ["TARGET", ...extraNames, ...controlNames] as string[];`,
"standardizedBeta controls",
);

replaceOnce(
`function fitDailyBuckets(
  buckets: Map<string, RegressionObservation[]>,
  horizon: SupplyForwardHorizon,
  minCrossSection: number,
  extraNames: string[] = [],
) {
  const fits: DailyFit[] = [];
  for (const [key, observations] of buckets) {
    if (observations.length < minCrossSection) continue;
    const [market, date] = key.split("|") as [SupplyMarket, string];
    const raw = standardizedBeta(observations, "yRaw", extraNames);
    const excess = standardizedBeta(observations, "yExcess", extraNames);`,
`function fitDailyBuckets(
  buckets: Map<string, RegressionObservation[]>,
  horizon: SupplyForwardHorizon,
  minCrossSection: number,
  extraNames: string[] = [],
  controlNames: readonly VfFeatureId[] = V8_VF_FEATURE_IDS,
) {
  const fits: DailyFit[] = [];
  for (const [key, observations] of buckets) {
    if (observations.length < minCrossSection) continue;
    const [market, date] = key.split("|") as [SupplyMarket, string];
    const raw = standardizedBeta(observations, "yRaw", extraNames, controlNames);
    const excess = standardizedBeta(observations, "yExcess", extraNames, controlNames);`,
"fitDailyBuckets controls",
);

const baselineStart = text.indexOf("function buildTechnicalBaselineFits(");
const interactionStart = text.indexOf("function buildInteractionFits(", baselineStart);
if (baselineStart < 0 || interactionStart < 0) throw new Error("V8-9 technical baseline function block not found");
const baselineBlock = text.slice(baselineStart, interactionStart);
const oldReturn = "  return fitDailyBuckets(buckets, horizon, minCrossSection).fits;\n}\n\n";
if (!baselineBlock.includes(oldReturn)) throw new Error("V8-9 technical baseline return not found");
const fixedBlock = baselineBlock.replace(
  oldReturn,
  "  const controlNames = V8_VF_FEATURE_IDS.filter((feature) => feature !== targetFeature);\n  return fitDailyBuckets(buckets, horizon, minCrossSection, [], controlNames).fits;\n}\n\n",
);
text = text.slice(0, baselineStart) + fixedBlock + text.slice(interactionStart);

fs.writeFileSync(path, text);
console.log("Applied V8-9 standalone technical-baseline control fix.");
