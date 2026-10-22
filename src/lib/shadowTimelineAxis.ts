import { validDate } from "./ledger/date";
const DAY = 86_400_000;
const stamp = (date: string) => Date.parse(`${date}T00:00:00Z`);
const dateOf = (value: number) => new Date(value).toISOString().slice(0, 10);

/** Calendar-time spacing: weekends retain their real width; labels use aligned calendar intervals. */
export function shadowTimelineAxis(from: string, to: string) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error("Invalid chart date range");
  const start = stamp(from),
    end = stamp(to),
    span = Math.round((end - start) / DAY);
  const ticks: string[] = [];
  let interval: string;
  if (span <= 14) {
    interval = "1일 간격";
    for (let time = start; time <= end; time += DAY) ticks.push(dateOf(time));
  } else if (span <= 90) {
    interval = "1주 간격 · 월요일";
    const weekday = new Date(start).getUTCDay();
    const firstMonday = start + ((8 - weekday) % 7) * DAY;
    for (let time = firstMonday; time <= end; time += 7 * DAY) ticks.push(dateOf(time));
  } else if (span <= 3653) {
    const months =
      (new Date(end).getUTCFullYear() - new Date(start).getUTCFullYear()) * 12 +
      new Date(end).getUTCMonth() -
      new Date(start).getUTCMonth();
    const step = [1, 2, 3, 6, 12].find((value) => months / value <= 12) ?? 12;
    interval = `${step}개월 간격 · 월초`;
    let month = new Date(start).getUTCFullYear() * 12 + new Date(start).getUTCMonth();
    month = Math.ceil(month / step) * step;
    for (; ; month += step) {
      const time = Date.UTC(Math.floor(month / 12), month % 12, 1);
      if (time > end) break;
      if (time >= start) ticks.push(dateOf(time));
    }
  } else {
    const years = new Date(end).getUTCFullYear() - new Date(start).getUTCFullYear();
    const step = Math.max(1, Math.ceil(years / 10));
    interval = `${step}년 간격 · 연초`;
    for (let year = Math.ceil(new Date(start).getUTCFullYear() / step) * step; ; year += step) {
      const time = Date.UTC(year, 0, 1);
      if (time > end) break;
      if (time >= start) ticks.push(dateOf(time));
    }
  }
  return {
    ticks,
    interval,
    label: (date: string) =>
      span <= 90 ? date.slice(5) : span <= 3653 ? date.slice(0, 7) : date.slice(0, 4),
    fraction: (date: string) => (end === start ? 0.5 : (stamp(date) - start) / (end - start)),
  };
}
