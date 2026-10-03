/** New journal contracts. Existing app documents remain authoritative until an audited cutover. */
import type { ActualExecution } from "../portfolioLedgers";
export type Decimal = string;
export type Currency = "KRW" | "USD";
export type EventKind =
  | "BUY"
  | "SELL"
  | "DIVIDEND"
  | "INTEREST"
  | "FEE"
  | "TAX"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "FX"
  | "TRANSFER"
  | "CORPORATE_ACTION";
export interface Security {
  id: string;
  symbol: string;
  name: string;
  market: "KOSPI" | "KOSDAQ" | "US";
  assetType: "STOCK" | "ETF" | "UNKNOWN";
  currency: Currency;
  notionPageId: string | null;
}
export interface SourceRef {
  system: "portfolio_ledgers" | "us_actual_portfolio_ledgers" | "notion" | "broker" | "model";
  recordId: string;
  revision: string;
  contentHash: string;
}
export interface EvidenceRef {
  id: string;
  source: SourceRef;
  /** Stable Notion file ID or private Storage bucket/path; never an expiring signed URL. */
  locator: string;
  sha256: string | null;
}
export interface CashLeg {
  accountId: string;
  currency: Currency;
  /** Signed net movement in the leg's own currency. Null means unknown, never zero. */
  amount: Decimal | null;
}
export interface PositionLeg {
  accountId: string;
  securityId: string;
  quantity: Decimal;
  /** Required for explicit corporate-action cost-basis adjustments; ordinary fills derive basis. */
  basisAdjustment: Decimal | null;
}
export interface LedgerEvent {
  /** Lossless legacy observation, not proof of broker settlement or fees. */
  legacyExecution?: ActualExecution<string>;
  /** Lossless website input for this revision; never overwrites the initial legacy observation. */
  appExecution?: ActualExecution<string>;
  id: string;
  revision: number;
  previousRevision: number | null;
  correctionReason: string | null;
  recordedAt: string;
  recordedBy: string;
  effectiveDate: string;
  effectiveSequence: number;
  settlementDate: string | null;
  book: "ACTUAL" | "MODEL";
  /** ACTUAL is one logical journal. Models must use separate frozen series IDs. */
  bookId: string;
  kind: EventKind;
  voided: boolean;
  securityId: string | null;
  quantity: Decimal | null;
  price: Decimal | null;
  currency: Currency;
  gross: Decimal | null;
  fee: Decimal | null;
  tax: Decimal | null;
  cashLegs: CashLeg[];
  positionLegs: PositionLeg[];
  source: SourceRef;
  evidence: EvidenceRef[];
  /** Inert user-supplied provenance; not broker verification or fetched evidence. */
  sourceLinks?: import("./executionMemo").ExecutionSourceLink[] | undefined;
  brokerEventId: string | null;
  strategyId: string | null;
  signalId: string | null;
  orderId: string | null;
  issues: string[];
}
export interface OpeningBalance {
  book: "ACTUAL" | "MODEL";
  bookId: string;
  accountId: string;
  currency: Currency;
  date: string;
  /** Opening is immediately before the first event on this date. */
  cash: Decimal;
  positions: { securityId: string; quantity: Decimal; costBasis: Decimal | null }[];
  source: SourceRef;
  complete: boolean;
  recordedAt?: string;
}
export interface PriceMark {
  securityId: string;
  currency: Currency;
  date: string;
  price: Decimal;
  sourceHash: string;
  availableAt?: string;
}
export interface FxMark {
  base: Currency;
  quote: Currency;
  date: string;
  rate: Decimal;
  source: string;
  verified: boolean;
  availableAt?: string;
}
