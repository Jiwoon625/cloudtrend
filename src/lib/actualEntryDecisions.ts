import { z } from "zod";

export const ENTRY_REASONS = ["독립성 제한", "자금 부족", "판단 보류", "기타"] as const;
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
export const entryCandidateSchema = z
  .object({
    market: z.enum(["KOSPI", "KOSDAQ", "ETF", "US"]),
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9.^/-]{1,32}$/),
    name: z.string().trim().min(1).max(150),
    signalOriginDate: date,
  })
  .strict();
export type EntryDecisionCandidate = z.infer<typeof entryCandidateSchema>;
const set = entryCandidateSchema
  .extend({
    action: z.literal("set"),
    id: z.string().uuid(),
    reason: z.enum(ENTRY_REASONS),
    scope: z.enum(["signal", "symbol"]),
    note: z.string().trim().max(300),
  })
  .strict();
const release = z
  .object({ action: z.literal("release"), id: z.string().uuid(), targetId: z.string().uuid() })
  .strict();
export const entryCommandSchema = z.discriminatedUnion("action", [set, release]);
export type EntryCommand = z.infer<typeof entryCommandSchema>;
export type EntryDecision = z.infer<typeof set> & { recordedAt: string };
const event = z.object({ command: entryCommandSchema, recordedAt: z.string().datetime() }).strict();
export const entryDocumentSchema = z
  .object({ revision: z.number().int().nonnegative(), events: z.array(event) })
  .strict()
  .refine(
    (d) =>
      d.revision === d.events.length &&
      new Set(d.events.map((e) => e.command.id)).size === d.events.length,
  );
export type EntryDecisionDocument = z.infer<typeof entryDocumentSchema>;
export const emptyEntryDecisions = (): EntryDecisionDocument => ({ revision: 0, events: [] });
export function activeEntryDecisions(doc: EntryDecisionDocument): EntryDecision[] {
  const active = new Map<string, EntryDecision>();
  for (const e of doc.events) {
    if (e.command.action === "release") active.delete(e.command.targetId);
    else active.set(e.command.id, { ...e.command, recordedAt: e.recordedAt });
  }
  return [...active.values()];
}
export function findEntryDecision(
  entries: readonly EntryDecision[] | undefined,
  market: string,
  symbol: string,
  origin: string,
): EntryDecision | undefined {
  const matching = entries?.filter(
    (e) =>
      e.market === market &&
      e.symbol === symbol &&
      (e.scope === "symbol" || e.signalOriginDate === origin),
  );
  return matching?.find((e) => e.scope === "symbol") ?? matching?.[0];
}
export function entryDecisionLabel(d: EntryDecision): string {
  return `미매수 · ${d.reason}${d.scope === "symbol" ? " (해제 전까지)" : ""}`;
}
export function applyEntryCommand(
  doc: EntryDecisionDocument,
  raw: EntryCommand,
  expectedRevision: number,
  now: string,
): EntryDecisionDocument {
  const command = entryCommandSchema.parse(raw);
  const prior = doc.events.find((e) => e.command.id === command.id);
  if (prior) {
    if (JSON.stringify(prior.command) !== JSON.stringify(command))
      throw new Error("동일 요청의 내용이 다릅니다. 다시 조회하세요.");
    return doc; // Lost-response retry; never append twice.
  }
  if (doc.revision !== expectedRevision)
    throw new Error("다른 창에서 미매수 기록이 변경되었습니다. 다시 조회 후 저장하세요.");
  const active = activeEntryDecisions(doc);
  if (command.action === "release") {
    if (!active.some((e) => e.id === command.targetId))
      throw new Error("이미 해제된 기록입니다. 다시 조회하세요.");
  } else if (findEntryDecision(active, command.market, command.symbol, command.signalOriginDate)) {
    throw new Error("이미 미매수로 지정된 종목입니다. 기존 기록을 해제한 뒤 변경하세요.");
  }
  return entryDocumentSchema.parse({
    revision: doc.revision + 1,
    events: [...doc.events, { command, recordedAt: now }],
  });
}
