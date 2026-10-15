import { ownerPath, readObject } from "./cloud";
import {
  KOSPI_SHADOW_NAMESPACE,
  type KospiShadowRegistry,
  type KospiShadowView,
} from "./kospiShadowStore";
import { KOSPI_SHADOW_POLICY, type KospiShadowSnapshot } from "./engine/kospiShadow";
import { hashSeriesValue } from "./ledger/modelSeries";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  assertKospiShadowRevisionView,
  kospiShadowRevision,
  validateKospiShadowRevision,
  validateKospiShadowRevisionJournal,
} from "./kospiShadowSeries";
export type KospiShadowReader = <T>(path: string) => Promise<T | null>;
/** Read-only selection. A partial correction is an error, never an original-series fallback. */
export async function loadKospiShadowFromReader(
  read: KospiShadowReader,
  original = false,
): Promise<KospiShadowView | null> {
  if (!original) {
    const namespace = `${KOSPI_SHADOW_NAMESPACE}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
    const [rawRevision, registry, view] = await Promise.all([
      read<unknown>(`${namespace}/revision.json`),
      read<KospiShadowRegistry>(`${namespace}/registry.json`),
      read<KospiShadowView>(`${namespace}/latest.json`),
    ]);
    if (rawRevision !== null || registry !== null || view !== null) {
      if (!rawRevision || !registry || !view)
        throw new Error(
          "KOSPI Shadow 사후 정정본 저장이 완결되지 않았습니다. 원본으로 자동 전환하지 않습니다.",
        );
      const revision = validateKospiShadowRevision(rawRevision);
      await assertKospiShadowRevisionView(view, revision);
      if ((await hashSeriesValue(registry)) !== (await hashSeriesValue(view.registry)))
        throw new Error("KOSPI Shadow 사후 정정본의 등록 정보가 일치하지 않습니다.");
      const [parentRegistry, predecessor, originalTarget] = await Promise.all([
        read<KospiShadowRegistry>(`${KOSPI_SHADOW_NAMESPACE}/registry.json`),
        read<KospiShadowSnapshot>(
          `${KOSPI_SHADOW_NAMESPACE}/sessions/${revision.predecessorDate}.json`,
        ),
        read<KospiShadowSnapshot>(
          `${KOSPI_SHADOW_NAMESPACE}/sessions/${revision.correctionDate}.json`,
        ),
      ]);
      if (
        !parentRegistry ||
        !predecessor ||
        !originalTarget ||
        (await hashSeriesValue(parentRegistry)) !== revision.parentRegistryHash ||
        (await hashSeriesValue(predecessor)) !== revision.expectedPredecessorHash ||
        (await hashSeriesValue(originalTarget)) !== revision.expectedOriginalTargetHash
      )
        throw new Error("KOSPI Shadow 사후 정정본의 원본 연결을 확인할 수 없습니다.");
      await validateKospiShadowRevisionJournal(read, namespace, view, revision);
      return view;
    }
  }
  const view = await read<KospiShadowView>(`${KOSPI_SHADOW_NAMESPACE}/latest.json`);
  if (!view) {
    if (await read(`${KOSPI_SHADOW_NAMESPACE}/registry.json`))
      throw new Error(
        "KOSPI Shadow 일별 기록의 최신 조회본을 복구해야 합니다. 기존 자금과 기록은 초기화하지 않습니다.",
      );
    return null;
  }
  if (
    view.schemaVersion !== 1 ||
    view.registry.strategyId !== KOSPI_SHADOW_POLICY.id ||
    view.registry.ruleVersion !== KOSPI_SHADOW_POLICY.version ||
    view.latest.state.strategyId !== KOSPI_SHADOW_POLICY.id ||
    kospiShadowRevision(view) !== null
  )
    throw new Error("KOSPI Shadow 원본 기록 버전이 일치하지 않습니다.");
  return view;
}
export async function loadKospiShadow(original = false): Promise<KospiShadowView | null> {
  const read: KospiShadowReader = async <T>(path: string) => readObject<T>(await ownerPath(path));
  return loadKospiShadowFromReader(read, original);
}
