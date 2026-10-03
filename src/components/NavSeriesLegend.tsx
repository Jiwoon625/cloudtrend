import { navSeriesStyle } from "@/lib/navSeries";

export function NavSeriesLegend({
  series,
}: {
  series: Array<{ id: string; label: string; status?: string }>;
}) {
  return (
    <ul aria-label="NAV 차트 범례" className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
      {series.map(({ id, label, status }) => {
        const style = navSeriesStyle(id);
        return (
          <li key={id} className="inline-flex min-w-0 items-center gap-2">
            <svg aria-hidden="true" width="28" height="12" className="shrink-0">
              <line
                x1="0"
                y1="6"
                x2="28"
                y2="6"
                stroke={style.color}
                strokeWidth="3"
                strokeDasharray={style.dash}
              />
            </svg>
            <span>
              {label}
              {status ? <span className="text-muted-foreground"> · {status}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
