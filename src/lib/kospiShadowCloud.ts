import { ownerPath, readObject } from "./cloud";
import { KOSPI_SHADOW_NAMESPACE, type KospiShadowView } from "./kospiShadowStore";
import { KOSPI_SHADOW_POLICY } from "./engine/kospiShadow";
export async function loadKospiShadow(): Promise<KospiShadowView | null> {
  const view = await readObject<KospiShadowView>(
    await ownerPath(`${KOSPI_SHADOW_NAMESPACE}/latest.json`),
  );
  if (!view) {
    const registry = await readObject(await ownerPath(`${KOSPI_SHADOW_NAMESPACE}/registry.json`));
    if (registry)
      throw new Error(
        "KOSPI Shadow 일별 기록의 최신 조회본을 복구해야 합니다. 기존 자금과 기록은 초기화하지 않습니다.",
      );
  }
  if (
    view &&
    (view.schemaVersion !== 1 ||
      view.registry.strategyId !== KOSPI_SHADOW_POLICY.id ||
      view.registry.ruleVersion !== KOSPI_SHADOW_POLICY.version ||
      view.latest.state.strategyId !== KOSPI_SHADOW_POLICY.id)
  )
    throw new Error("KOSPI Shadow 기록 버전이 일치하지 않습니다.");
  return view;
}
