import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { inputCls } from "./ui";
// Custom calendar picker for date/datetime fields. Renders a native text input
// that opens an inline month-grid calendar on focus — no browser-native
// date widget, so behavior is identical across browsers/OSes.
//
// value/onChange use the same string formats as <input type="date|datetime-local">:
//   date:      "YYYY-MM-DD"
//   datetime:  "YYYY-MM-DDTHH:MM"

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toDateTimeString(d: Date): string {
  return `${toDateString(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Parsed {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

function parseValue(value: string): Parsed | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], hh: m[4] !== undefined ? +m[4] : 0, mm: m[5] !== undefined ? +m[5] : 0 };
}

function displayValue(value: string, withTime: boolean): string {
  const p = parseValue(value);
  if (!p) return value;
  const base = `${pad(p.d)} ${MONTHS[p.m - 1]} ${p.y}`;
  return withTime ? `${base} · ${pad(p.hh)}:${pad(p.mm)}` : base;
}

export function CalendarPicker({
  value,
  onChange,
  withTime = false,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  withTime?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState<Parsed | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // The month shown in the grid — defaults to the selected value or today.
  const [view, setView] = useState<Date>(() => {
    const p = parseValue(value);
    const base = p ? new Date(p.y, p.m - 1, 1) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  // Keep the in-popup state in sync with the (possibly external) value.
  useEffect(() => {
    if (open) {
      setTime(parseValue(value) ?? null);
      const p = parseValue(value);
      if (p) setView(new Date(p.y, p.m - 1, 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const today = new Date();
  const selected = time ? new Date(time.y, time.m - 1, time.d) : null;

  const cells = useMemo(() => {
    const firstWeekday = (view.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < firstWeekday; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(view.getFullYear(), view.getMonth(), d));
    return out;
  }, [view]);

  const commitNow = () => {
    if (!time) return;
    const next = new Date(time.y, time.m - 1, time.d, time.hh, time.mm);
    onChange(withTime ? toDateTimeString(next) : toDateString(next));
    setOpen(false);
  };

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${inputCls} flex items-center justify-between gap-2 text-left`}
      >
        <span className={value ? "text-ink" : "text-dim/60"}>
          {value ? displayValue(value, withTime) : (placeholder ?? (withTime ? "Pick date & time" : "Pick a date"))}
        </span>
        <CalendarIcon className="h-4 w-4 shrink-0 text-dim" />
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-xl border border-line bg-panel p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
              aria-label="Previous month"
              className="rounded-lg p-1 text-dim hover:bg-panel-2 hover:text-ink"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold text-ink">
              {MONTHS[view.getMonth()]} {view.getFullYear()}
            </span>
            <button
              type="button"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
              aria-label="Next month"
              className="rounded-lg p-1 text-dim hover:bg-panel-2 hover:text-ink"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center">
            {DAYS.map((d) => (
              <span key={d} className="py-1 text-[10px] font-bold uppercase tracking-wide text-dim">
                {d}
              </span>
            ))}
            {cells.map((d, i) =>
              d ? (
                <button
                  key={i}
                  type="button"
                  onClick={() => setTime({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hh: time?.hh ?? 0, mm: time?.mm ?? 0 })}
                  className={`rounded-lg py-1 text-sm transition-colors ${
                    selected && isSameDay(selected, d)
                      ? "bg-amber font-bold text-bg"
                      : isSameDay(today, d)
                        ? "font-semibold text-amber"
                        : "text-ink hover:bg-panel-2"
                  }`}
                >
                  {d.getDate()}
                </button>
              ) : (
                <span key={i} />
              )
            )}
          </div>

          {withTime ? (
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-dim">Time</span>
              <select
                className="flex-1 rounded-lg border border-line bg-bg px-2 py-1.5 text-sm text-ink focus:border-amber/60 focus:outline-none"
                value={time?.hh ?? 0}
                onChange={(e) => setTime((t) => ({ y: t?.y ?? view.getFullYear(), m: t?.m ?? view.getMonth() + 1, d: t?.d ?? 1, hh: +e.target.value, mm: t?.mm ?? 0 }))}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {pad(h)}
                  </option>
                ))}
              </select>
              <span className="text-dim">:</span>
              <select
                className="flex-1 rounded-lg border border-line bg-bg px-2 py-1.5 text-sm text-ink focus:border-amber/60 focus:outline-none"
                value={time?.mm ?? 0}
                onChange={(e) => setTime((t) => ({ y: t?.y ?? view.getFullYear(), m: t?.m ?? view.getMonth() + 1, d: t?.d ?? 1, hh: t?.hh ?? 0, mm: +e.target.value }))}
              >
                {Array.from({ length: 60 }, (_, m) => (
                  <option key={m} value={m}>
                    {pad(m)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5">
            <button
              type="button"
              onClick={() => {
                setTime({ y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate(), hh: today.getHours(), mm: today.getMinutes() });
                setView(new Date(today.getFullYear(), today.getMonth(), 1));
              }}
              className="text-xs font-semibold text-dim hover:text-ink"
            >
              Today
            </button>
            <button
              type="button"
              onClick={commitNow}
              className="rounded-lg bg-amber px-3 py-1.5 text-xs font-bold text-bg hover:bg-amber/90"
            >
              Set
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
