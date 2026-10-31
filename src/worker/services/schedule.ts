import type { RuleGuards } from "./rule-engine";

export interface BusinessHours {
  timezone: string;
  start: string;
  end: string;
  days: number[];
}

function parseTime(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export function withinBusinessHours(hours: BusinessHours, at = new Date()): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: hours.timezone || "UTC",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = weekdayMap[get("weekday")] ?? at.getUTCDay();
    if (!hours.days.includes(day)) return false;
    const minutes = Number(get("hour")) * 60 + Number(get("minute"));
    const start = parseTime(hours.start);
    const end = parseTime(hours.end);
    if (start <= end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
  } catch {
    return true;
  }
}

export function isBusinessHoursAllowed(guards: RuleGuards, at = new Date()): boolean {
  if (!guards.businessHours) return true;
  return withinBusinessHours(guards.businessHours, at);
}
