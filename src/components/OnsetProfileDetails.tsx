import type { OnsetProfile } from "@/lib/onsetProfile";

function points(value: number) {
  return `+${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}`;
}

function extension(value: number | null) {
  if (value === null) return "산정 불가";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function OnsetProfileDetails({
  profile,
  compact = false,
}: {
  profile: OnsetProfile | null | undefined;
  compact?: boolean;
}) {
  if (!profile) return null;
  return (
    <div
      className={
        compact
          ? "mt-1 text-[10px] leading-relaxed text-muted-foreground"
          : "text-[12px] leading-relaxed"
      }
      data-onset-profile={profile.type}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="font-semibold text-foreground">
          {profile.label} ({profile.type})
        </span>
        <span>
          새 점수{" "}
          {profile.addedFeatures.map((item) => `${item.label} ${points(item.points)}`).join(" · ")}
        </span>
        <span className="num">MA20 이격 {extension(profile.ma20Extension)}</span>
      </div>
    </div>
  );
}
