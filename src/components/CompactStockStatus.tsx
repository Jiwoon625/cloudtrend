import type { CompactStockStatus as Status } from "@/lib/stockCompactStatus";

export function CompactStockStatus({ status }: { status: Status }) {
  const color =
    status.tone === "danger"
      ? "text-down"
      : status.tone === "warn"
        ? "text-warn"
        : status.tone === "positive"
          ? "text-up"
          : "text-foreground";
  return (
    <div
      className="h-9 w-40 max-w-40 sm:w-56 sm:max-w-56 text-[11px] leading-[18px]"
      aria-label={`${status.primary}. ${status.secondary}`}
      data-compact-stock-status
    >
      <span className={`block truncate font-medium ${color}`}>{status.primary}</span>
      <span className="block truncate text-muted-foreground">{status.secondary}</span>
    </div>
  );
}
