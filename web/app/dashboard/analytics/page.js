"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAnalytics } from "@/lib/platformApi";

// GET /api/dashboard/analytics?days=N returns:
//   days, since, codecs[], limitedBy{}, quality{}, bandwidth{},
//   peers[] (already sorted worst-first), timeline[], bandwidthDaily[]
//
// The question this page exists to answer is "why is this slow" — so software
// vs hardware encoding and the limiting factor are given the most room, and
// every raw number carries a caption saying what it means.

const RING = "ring-1 ring-zinc-950/10 dark:ring-white/10";
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-950";

const RANGES = [1, 7, 30];

// The droplet's transfer allowance, for the bandwidth section's context line.
const PLAN_GB_PER_MONTH = 500;

// Series colours are the two leading slots of a CVD-validated categorical set
// (adjacent ΔE 24.7 light / 26.8 dark against this app's white / near-black
// surfaces). Status colours are a separate reserved set and always ship beside
// a written label, never as colour alone.
const KBPS_STROKE = "stroke-[#2a78d6] dark:stroke-[#3987e5]";
const KBPS_FILL = "fill-[#2a78d6] dark:fill-[#3987e5]";
const KBPS_SWATCH = "bg-[#2a78d6] dark:bg-[#3987e5]";
const FPS_STROKE = "stroke-[#eb6834] dark:stroke-[#d95926]";
const FPS_FILL = "fill-[#eb6834] dark:fill-[#d95926]";
const FPS_SWATCH = "bg-[#eb6834] dark:bg-[#d95926]";
const CPU_FILL = "fill-[#d03b3b]";
const CPU_SWATCH = "bg-[#d03b3b]";

const GRID = "stroke-zinc-950/10 dark:stroke-white/10";
const AXIS = "stroke-zinc-950/20 dark:stroke-white/20";
const TICK = "fill-zinc-500 dark:fill-zinc-400";
const SURFACE_STROKE = "stroke-white dark:stroke-zinc-950";

// ---------------------------------------------------------------- formatting

/** Numbers the server could not compute come back as null — never print them. */
function fmt(value, digits = 0) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pctText(part, total) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Timeline hours arrive as "2026-08-12T07:00" in UTC, with no zone marker. */
function hourToDate(hour) {
  const d = new Date(`${hour}:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatHour(hour, withDay) {
  const d = hourToDate(hour);
  if (!d) return String(hour ?? "");
  return d.toLocaleString(
    undefined,
    withDay
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" }
  );
}

function formatDay(day) {
  const parts = String(day ?? "").split("-");
  if (parts.length !== 3) return String(day ?? "");
  const d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
  if (Number.isNaN(d.getTime())) return String(day);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// -------------------------------------------------------------- chart basics

/** Round an axis maximum up to a value that produces clean tick labels. */
function niceCeil(value) {
  if (!(value > 0)) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const scaled = value / base;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * base;
}

function linePath(points) {
  return points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
}

function areaPath(points, baseY) {
  if (!points.length) return "";
  const first = points[0];
  const last = points[points.length - 1];
  const body = points.map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  return `M${first.x.toFixed(1)} ${baseY} ${body} L${last.x.toFixed(1)} ${baseY} Z`;
}

/** A column with a rounded cap and a square foot on the baseline. */
function columnPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x} ${y + h} L${x} ${y + rr} Q${x} ${y} ${x + rr} ${y} L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} L${x + w} ${y + h} Z`;
}

/** Evenly spaced indices, so axis labels never collide on narrow screens. */
function tickIndices(count, max) {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(Math.round(i * step));
  return Array.from(new Set(out));
}

/**
 * Charts are drawn at the container's real pixel width rather than scaled from
 * a fixed viewBox, so labels stay at their intended size on every screen.
 */
function useMeasuredWidth(fallback) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => {
      const next = Math.round(el.clientWidth);
      if (next > 0) setWidth(next);
    };
    update();

    // The observer is the real mechanism; the window listener is a fallback so
    // a chart measured while it was hidden (zero width) still corrects itself.
    window.addEventListener("resize", update);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);

    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, []);

  return [ref, width];
}

function Tooltip({ x, width, children }) {
  const clamped = Math.min(Math.max(x, 90), Math.max(width - 90, 90));
  return (
    <div
      className="pointer-events-none absolute top-2 z-10 -translate-x-1/2 rounded-lg bg-white/95 px-3 py-2 text-xs whitespace-nowrap shadow-lg ring-1 ring-zinc-950/10 backdrop-blur dark:bg-zinc-900/95 dark:ring-white/15"
      style={{ left: clamped }}
    >
      {children}
    </div>
  );
}

function LegendKey({ swatch, label, shape = "line" }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={`${swatch} ${shape === "line" ? "h-0.5 w-4 rounded-full" : "h-2.5 w-2.5 rounded-sm"}`}
      />
      <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
    </span>
  );
}

function ChartEmpty({ children }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-lg bg-zinc-950/[0.02] px-6 text-center text-sm text-zinc-500 dark:bg-white/[0.03] dark:text-zinc-400">
      {children}
    </div>
  );
}

// ----------------------------------------------------------- timeline chart

const T_PAD_L = 54;
const T_PAD_R = 14;
const T_PAD_T = 18;
const T_PANEL_H = 118;
const T_PANEL_GAP = 34;
const T_STRIP_GAP = 10;
const T_STRIP_H = 12;
const T_AXIS_H = 26;
const T_HEIGHT =
  T_PAD_T + T_PANEL_H * 2 + T_PANEL_GAP + T_STRIP_GAP + T_STRIP_H + T_AXIS_H;

function TimelineChart({ rows }) {
  const [wrapRef, width] = useMeasuredWidth(880);
  const [hover, setHover] = useState(null);

  const n = rows.length;
  const innerW = Math.max(60, width - T_PAD_L - T_PAD_R);

  const panel1Top = T_PAD_T;
  const panel1Bottom = panel1Top + T_PANEL_H;
  const panel2Top = panel1Bottom + T_PANEL_GAP;
  const panel2Bottom = panel2Top + T_PANEL_H;
  const stripTop = panel2Bottom + T_STRIP_GAP;

  const kbpsMax = niceCeil(Math.max(...rows.map((r) => num(r.avgKbps)), 0));
  const fpsMax = niceCeil(Math.max(...rows.map((r) => num(r.avgFps)), 0));

  const xAt = (i) => (n === 1 ? T_PAD_L + innerW / 2 : T_PAD_L + (i / (n - 1)) * innerW);
  const kbpsY = (v) => panel1Bottom - (num(v) / kbpsMax) * T_PANEL_H;
  const fpsY = (v) => panel2Bottom - (num(v) / fpsMax) * T_PANEL_H;

  const kbpsPoints = rows.map((r, i) => ({ x: xAt(i), y: kbpsY(r.avgKbps) }));
  const fpsPoints = rows.map((r, i) => ({ x: xAt(i), y: fpsY(r.avgFps) }));

  const first = hourToDate(rows[0]?.hour);
  const last = hourToDate(rows[n - 1]?.hour);
  const spansDays = Boolean(first && last && last - first > 26 * 3600 * 1000);
  const xTicks = tickIndices(n, Math.max(2, Math.min(7, Math.floor(innerW / 110))));

  const bandW = n > 1 ? innerW / (n - 1) : innerW;
  const cpuTotal = rows.reduce((sum, r) => sum + num(r.cpuLimited), 0);

  const summary =
    `Two stacked panels sharing one timeline over ${n} hourly ${n === 1 ? "point" : "points"}. ` +
    `Top panel: average bitrate, peaking at ${fmt(Math.max(...rows.map((r) => num(r.avgKbps))))} kbps. ` +
    `Bottom panel: average frame rate, peaking at ${fmt(Math.max(...rows.map((r) => num(r.avgFps))), 1)} fps. ` +
    `${cpuTotal ? `${fmt(cpuTotal)} samples were CPU-limited.` : "No samples were CPU-limited."}`;

  function pointerIndex(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return 0;
    const rel = event.clientX - rect.left;
    if (n === 1) return 0;
    return Math.min(n - 1, Math.max(0, Math.round((rel / rect.width) * (n - 1))));
  }

  const active = hover === null ? null : rows[hover];

  return (
    <div ref={wrapRef} className="relative w-full overflow-hidden">
      <svg
        width={width}
        height={T_HEIGHT}
        viewBox={`0 0 ${width} ${T_HEIGHT}`}
        role="img"
        aria-label={summary}
        tabIndex={0}
        onFocus={() => setHover((h) => (h === null ? n - 1 : h))}
        onBlur={() => setHover(null)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setHover((h) => Math.min(n - 1, (h ?? 0) + 1));
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            setHover((h) => Math.max(0, (h ?? 0) - 1));
          } else if (event.key === "Escape") {
            setHover(null);
          }
        }}
        className={`block rounded-lg ${FOCUS}`}
      >
        {/* Hours where the encoder could not keep up, washed across both panels. */}
        {rows.map((r, i) => {
          const share = num(r.samples) ? num(r.cpuLimited) / num(r.samples) : 0;
          if (share <= 0) return null;
          return (
            <rect
              key={`cpu-${r.hour}`}
              x={xAt(i) - bandW / 2}
              y={panel1Top}
              width={bandW}
              height={panel2Bottom - panel1Top}
              className={CPU_FILL}
              fillOpacity={0.04 + share * 0.1}
            />
          );
        })}

        {[0, 0.5, 1].map((f) => (
          <g key={`g1-${f}`}>
            <line
              x1={T_PAD_L}
              x2={T_PAD_L + innerW}
              y1={panel1Bottom - f * T_PANEL_H}
              y2={panel1Bottom - f * T_PANEL_H}
              className={f === 0 ? AXIS : GRID}
              strokeWidth="1"
            />
            <text
              x={T_PAD_L - 8}
              y={panel1Bottom - f * T_PANEL_H + 4}
              textAnchor="end"
              className={`${TICK} text-[10px] tabular-nums`}
            >
              {fmt(kbpsMax * f)}
            </text>
          </g>
        ))}

        {[0, 0.5, 1].map((f) => (
          <g key={`g2-${f}`}>
            <line
              x1={T_PAD_L}
              x2={T_PAD_L + innerW}
              y1={panel2Bottom - f * T_PANEL_H}
              y2={panel2Bottom - f * T_PANEL_H}
              className={f === 0 ? AXIS : GRID}
              strokeWidth="1"
            />
            <text
              x={T_PAD_L - 8}
              y={panel2Bottom - f * T_PANEL_H + 4}
              textAnchor="end"
              className={`${TICK} text-[10px] tabular-nums`}
            >
              {fmt(fpsMax * f, fpsMax < 5 ? 1 : 0)}
            </text>
          </g>
        ))}

        <text x={T_PAD_L} y={panel1Top - 6} className={`${TICK} text-[10px]`}>
          Average bitrate (kbps)
        </text>
        <text x={T_PAD_L} y={panel2Top - 6} className={`${TICK} text-[10px]`}>
          Average frame rate (fps)
        </text>

        {n > 1 && (
          <>
            <path d={areaPath(kbpsPoints, panel1Bottom)} className={KBPS_FILL} fillOpacity={0.1} />
            <path
              d={linePath(kbpsPoints)}
              fill="none"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              className={KBPS_STROKE}
            />
            <path d={areaPath(fpsPoints, panel2Bottom)} className={FPS_FILL} fillOpacity={0.1} />
            <path
              d={linePath(fpsPoints)}
              fill="none"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              className={FPS_STROKE}
            />
          </>
        )}

        {n === 1 && (
          <>
            <circle cx={kbpsPoints[0].x} cy={kbpsPoints[0].y} r="5" className={KBPS_FILL} />
            <circle cx={fpsPoints[0].x} cy={fpsPoints[0].y} r="5" className={FPS_FILL} />
          </>
        )}

        {/* CPU-limited strip: how many of that hour's samples were CPU-bound. */}
        <text x={T_PAD_L - 8} y={stripTop + T_STRIP_H - 2} textAnchor="end" className={`${TICK} text-[10px]`}>
          CPU
        </text>
        <rect
          x={T_PAD_L}
          y={stripTop}
          width={innerW}
          height={T_STRIP_H}
          rx="3"
          className="fill-zinc-950/[0.04] dark:fill-white/[0.06]"
        />
        {rows.map((r, i) => {
          const share = num(r.samples) ? num(r.cpuLimited) / num(r.samples) : 0;
          if (share <= 0) return null;
          const w = Math.max(2, bandW - 2);
          return (
            <rect
              key={`strip-${r.hour}`}
              x={xAt(i) - w / 2}
              y={stripTop}
              width={w}
              height={T_STRIP_H}
              rx="3"
              className={CPU_FILL}
              fillOpacity={0.25 + share * 0.75}
            />
          );
        })}

        {xTicks.map((i) => (
          <text
            key={`x-${rows[i].hour}`}
            x={xAt(i)}
            y={T_HEIGHT - 8}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            className={`${TICK} text-[10px] tabular-nums`}
          >
            {formatHour(rows[i].hour, spansDays)}
          </text>
        ))}

        {active && (
          <g pointerEvents="none">
            <line
              x1={xAt(hover)}
              x2={xAt(hover)}
              y1={panel1Top}
              y2={panel2Bottom}
              className={AXIS}
              strokeWidth="1"
            />
            <circle cx={xAt(hover)} cy={kbpsY(active.avgKbps)} r="4" className={KBPS_FILL} />
            <circle
              cx={xAt(hover)}
              cy={kbpsY(active.avgKbps)}
              r="4"
              fill="none"
              strokeWidth="2"
              className={SURFACE_STROKE}
            />
            <circle cx={xAt(hover)} cy={fpsY(active.avgFps)} r="4" className={FPS_FILL} />
            <circle
              cx={xAt(hover)}
              cy={fpsY(active.avgFps)}
              r="4"
              fill="none"
              strokeWidth="2"
              className={SURFACE_STROKE}
            />
          </g>
        )}

        <rect
          x={T_PAD_L}
          y={panel1Top}
          width={innerW}
          height={stripTop + T_STRIP_H - panel1Top}
          fill="transparent"
          onMouseMove={(event) => setHover(pointerIndex(event))}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      {active && (
        <Tooltip x={xAt(hover)} width={width}>
          <p className="font-medium">{formatHour(active.hour, true)}</p>
          <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
            <dt className="text-zinc-500 dark:text-zinc-400">Bitrate</dt>
            <dd className="text-right">{fmt(active.avgKbps)} kbps</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Frame rate</dt>
            <dd className="text-right">{fmt(active.avgFps, 1)} fps</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Machines</dt>
            <dd className="text-right">{fmt(active.peers)}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">CPU-limited</dt>
            <dd className="text-right">
              {fmt(active.cpuLimited)} / {fmt(active.samples)}
            </dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Frames dropped</dt>
            <dd className="text-right">{fmt(active.framesDropped)}</dd>
          </dl>
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------- bandwidth chart

const B_PAD_L = 54;
const B_PAD_R = 14;
const B_PAD_T = 18;
const B_PLOT_H = 168;
const B_AXIS_H = 30;
const B_HEIGHT = B_PAD_T + B_PLOT_H + B_AXIS_H;

function BandwidthChart({ rows }) {
  const [wrapRef, width] = useMeasuredWidth(880);
  const [hover, setHover] = useState(null);

  const n = rows.length;
  const innerW = Math.max(60, width - B_PAD_L - B_PAD_R);
  const baseline = B_PAD_T + B_PLOT_H;

  const max = niceCeil(Math.max(...rows.map((r) => num(r.gbSent)), 0));
  const band = innerW / n;
  const barW = Math.min(28, Math.max(3, band - 2));
  const peak = rows.reduce(
    (best, r, i) => (num(r.gbSent) > num(rows[best]?.gbSent) ? i : best),
    0
  );

  const xAt = (i) => B_PAD_L + band * i + band / 2;
  const yAt = (v) => baseline - (num(v) / max) * B_PLOT_H;

  const xTicks = tickIndices(n, Math.max(2, Math.min(10, Math.floor(innerW / 64))));
  const total = rows.reduce((sum, r) => sum + num(r.gbSent), 0);

  const summary =
    `Outbound transfer per day across ${n} ${n === 1 ? "day" : "days"}, ` +
    `totalling ${fmt(total, 2)} GB, peaking at ${fmt(num(rows[peak]?.gbSent), 2)} GB on ${formatDay(rows[peak]?.day)}.`;

  return (
    <div ref={wrapRef} className="relative w-full overflow-hidden">
      <svg
        width={width}
        height={B_HEIGHT}
        viewBox={`0 0 ${width} ${B_HEIGHT}`}
        role="img"
        aria-label={summary}
        className="block"
      >
        {[0, 0.5, 1].map((f) => (
          <g key={`bg-${f}`}>
            <line
              x1={B_PAD_L}
              x2={B_PAD_L + innerW}
              y1={baseline - f * B_PLOT_H}
              y2={baseline - f * B_PLOT_H}
              className={f === 0 ? AXIS : GRID}
              strokeWidth="1"
            />
            <text
              x={B_PAD_L - 8}
              y={baseline - f * B_PLOT_H + 4}
              textAnchor="end"
              className={`${TICK} text-[10px] tabular-nums`}
            >
              {fmt(max * f, max < 5 ? 2 : 0)}
            </text>
          </g>
        ))}

        <text x={B_PAD_L} y={B_PAD_T - 6} className={`${TICK} text-[10px]`}>
          GB sent
        </text>

        {rows.map((r, i) => {
          const y = yAt(r.gbSent);
          const h = Math.max(num(r.gbSent) > 0 ? 2 : 0, baseline - y);
          return (
            <g key={r.day}>
              {h > 0 && (
                <path
                  d={columnPath(xAt(i) - barW / 2, baseline - h, barW, h, 4)}
                  className={KBPS_FILL}
                  fillOpacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              <rect
                x={xAt(i) - band / 2}
                y={B_PAD_T}
                width={band}
                height={B_PLOT_H}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}

        {/* One direct label — the peak — rather than a number on every column. */}
        {max > 0 && num(rows[peak]?.gbSent) > 0 && (
          <text
            x={xAt(peak)}
            y={Math.max(B_PAD_T + 9, yAt(rows[peak].gbSent) - 6)}
            textAnchor="middle"
            className="fill-zinc-700 text-[10px] font-medium tabular-nums dark:fill-zinc-200"
          >
            {fmt(rows[peak].gbSent, 2)}
          </text>
        )}

        {xTicks.map((i) => (
          <text
            key={`bx-${rows[i].day}`}
            x={xAt(i)}
            y={B_HEIGHT - 10}
            textAnchor="middle"
            className={`${TICK} text-[10px] tabular-nums`}
          >
            {formatDay(rows[i].day)}
          </text>
        ))}
      </svg>

      {hover !== null && rows[hover] && (
        <Tooltip x={xAt(hover)} width={width}>
          <p className="font-medium">{formatDay(rows[hover].day)}</p>
          <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
            <dt className="text-zinc-500 dark:text-zinc-400">Sent</dt>
            <dd className="text-right">{fmt(rows[hover].gbSent, 2)} GB</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Received</dt>
            <dd className="text-right">{fmt(rows[hover].gbReceived, 2)} GB</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Sessions</dt>
            <dd className="text-right">{fmt(rows[hover].sessions)}</dd>
          </dl>
        </Tooltip>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ sections

function Card({ children, className = "" }) {
  return (
    <section className={`rounded-xl bg-white p-4 sm:p-5 dark:bg-zinc-950 ${RING} ${className}`}>
      {children}
    </section>
  );
}

function SectionHead({ title, hint, id, children }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 id={id} className="font-medium">
          {title}
        </h2>
        {hint && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function DataTable({ label, children }) {
  return (
    <details className="mt-4 group">
      <summary
        className={`inline-flex cursor-pointer list-none rounded-lg px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-950/5 dark:text-zinc-400 dark:hover:bg-white/5 ${FOCUS}`}
      >
        <span className="group-open:hidden">Show {label} as a table</span>
        <span className="hidden group-open:inline">Hide {label} table</span>
      </summary>
      <div className="mt-3 max-h-72 overflow-auto rounded-lg ring-1 ring-zinc-950/10 dark:ring-white/10">
        {children}
      </div>
    </details>
  );
}

const TH = "px-3 py-2 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400";
const TD = "px-3 py-2 text-sm tabular-nums whitespace-nowrap";

// -- 2. health verdict --------------------------------------------------------

function IdentityChips({ items }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5">
      {items.map((p) => (
        <li
          key={p.identity}
          className="rounded-full bg-white/70 px-2.5 py-1 text-xs font-medium ring-1 ring-zinc-950/10 dark:bg-zinc-950/50 dark:ring-white/15"
        >
          {p.identity}
          <span className="ml-1.5 font-normal text-zinc-500 tabular-nums dark:text-zinc-400">
            {p.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

function HealthVerdict({ peers }) {
  const softwarePeers = peers.filter((p) => num(p.softwarePct) > 50);
  const cpuLimitedPeers = peers.filter((p) => num(p.cpuLimitedPct) > 20);

  // Software encoding is the root cause worth shouting about; CPU pressure
  // without it is real but less clear-cut, so it gets amber rather than red.
  const level = softwarePeers.length ? "critical" : cpuLimitedPeers.length ? "warning" : "good";

  const shell = {
    critical:
      "bg-[#d03b3b]/10 ring-1 ring-[#d03b3b]/35 dark:bg-[#d03b3b]/15 dark:ring-[#d03b3b]/40",
    warning:
      "bg-[#fab219]/10 ring-1 ring-[#fab219]/45 dark:bg-[#fab219]/10 dark:ring-[#fab219]/35",
    good: "bg-[#0ca30c]/10 ring-1 ring-[#0ca30c]/30 dark:bg-[#0ca30c]/10 dark:ring-[#0ca30c]/30",
  }[level];

  const dot = {
    critical: "bg-[#d03b3b]",
    warning: "bg-[#fab219]",
    good: "bg-[#0ca30c]",
  }[level];

  const eyebrow = {
    critical: "Encoding problem",
    warning: "CPU pressure",
    good: "All clear",
  }[level];

  let headline;
  if (level === "critical") {
    headline = `${softwarePeers.length} ${
      softwarePeers.length === 1 ? "machine is" : "machines are"
    } encoding in software — their CPUs will be pinned`;
  } else if (level === "warning") {
    headline = `${cpuLimitedPeers.length} ${
      cpuLimitedPeers.length === 1 ? "machine is" : "machines are"
    } CPU-limited while encoding`;
  } else {
    headline = "No encoding problems detected";
  }

  return (
    <section aria-labelledby="verdict-heading" className={`rounded-2xl p-5 sm:p-7 ${shell}`}>
      <p className="flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
        <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${dot}`} />
        {eyebrow}
      </p>
      <h2
        id="verdict-heading"
        className="mt-2 text-2xl leading-tight font-semibold tracking-tight sm:text-3xl"
      >
        {headline}
      </h2>

      {level === "good" && (
        <p className="mt-3 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
          Every machine reporting in this window encoded in hardware and kept up with
          its own frame rate. If the app still feels slow, look at bandwidth and round-trip
          time below rather than at the encoders.
        </p>
      )}

      {softwarePeers.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">
            Encoding in software ({softwarePeers.length})
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
            These machines are compressing video on the CPU instead of the GPU&apos;s
            dedicated encoder. That is the usual explanation for a pinned core, a hot
            fan, and a browser sitting on several gigabytes of memory. Getting them onto
            H264 — or dropping their capture resolution and frame rate — is the fix.
          </p>
          <IdentityChips
            items={softwarePeers.map((p) => ({
              identity: p.identity,
              detail: `${fmt(p.softwarePct)}% software · ${p.codec || "?"}`,
            }))}
          />
        </div>
      )}

      {cpuLimitedPeers.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">
            CPU is the bottleneck ({cpuLimitedPeers.length})
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
            The browser reported that it had to reduce quality because the machine could
            not encode fast enough. Frame rate drops here before bitrate does.
          </p>
          <IdentityChips
            items={cpuLimitedPeers.map((p) => ({
              identity: p.identity,
              detail: `${fmt(p.cpuLimitedPct)}% of samples`,
            }))}
          />
        </div>
      )}
    </section>
  );
}

// -- 7. limiting factor -------------------------------------------------------

const LIMIT_KINDS = [
  {
    key: "none",
    label: "Nothing",
    bar: "bg-[#0ca30c]",
    ink: "text-white",
    note: "the encoder kept up",
  },
  {
    key: "cpu",
    label: "CPU",
    bar: "bg-[#d03b3b]",
    ink: "text-white",
    note: "the machine could not keep up",
  },
  {
    key: "bandwidth",
    label: "Bandwidth",
    bar: "bg-[#fab219]",
    ink: "text-zinc-950",
    note: "the network could not keep up",
  },
  {
    key: "unknown",
    label: "Unknown",
    bar: "bg-zinc-400 dark:bg-zinc-600",
    ink: "text-zinc-950 dark:text-white",
    note: "the browser did not say",
  },
];

function LimitingFactor({ limitedBy }) {
  const entries = Object.entries(limitedBy || {});
  const known = new Set(["none", "cpu", "bandwidth"]);

  const counts = { none: 0, cpu: 0, bandwidth: 0, unknown: 0 };
  for (const [key, value] of entries) {
    if (known.has(key)) counts[key] += num(value);
    else counts.unknown += num(value);
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const present = LIMIT_KINDS.filter((k) => counts[k.key] > 0);

  if (!total) {
    return <ChartEmpty>No samples reported a limiting factor in this window.</ChartEmpty>;
  }

  return (
    <>
      <div
        className="flex h-9 w-full gap-[2px] overflow-hidden rounded-lg"
        role="img"
        aria-label={`Limiting factor across ${fmt(total)} samples: ${present
          .map((k) => `${k.label} ${pctText(counts[k.key], total)}`)
          .join(", ")}.`}
      >
        {present.map((kind) => {
          const share = counts[kind.key] / total;
          return (
            <div
              key={kind.key}
              className={`flex items-center justify-center rounded-sm ${kind.bar}`}
              style={{ flexGrow: share }}
              title={`${kind.label}: ${fmt(counts[kind.key])} samples (${pctText(counts[kind.key], total)})`}
            >
              {/* Only label inside the segment when the text actually fits. */}
              {share > 0.14 && (
                <span className={`px-2 text-xs font-medium tabular-nums ${kind.ink}`}>
                  {pctText(counts[kind.key], total)}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {LIMIT_KINDS.map((kind) => (
          <div key={kind.key} className="flex items-baseline gap-2.5">
            <span aria-hidden className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-sm ${kind.bar}`} />
            <dt className="text-sm font-medium">{kind.label}</dt>
            <dd className="ml-auto text-sm tabular-nums">
              {fmt(counts[kind.key])}
              <span className="ml-2 text-zinc-500 dark:text-zinc-400">
                {pctText(counts[kind.key], total)}
              </span>
            </dd>
            <p className="w-full basis-full pl-5 text-xs text-zinc-500 dark:text-zinc-400">
              {kind.note}
            </p>
          </div>
        ))}
      </dl>
    </>
  );
}

// -- 3. stat tiles ------------------------------------------------------------

function StatTile({ label, value, unit, caption }) {
  return (
    <div className="bg-white p-4 dark:bg-zinc-950">
      <dt className="text-sm text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold">
        {value}
        {unit && value !== "—" && (
          <span className="ml-1 text-sm font-normal text-zinc-500 dark:text-zinc-400">{unit}</span>
        )}
      </dd>
      <p className="mt-1.5 text-xs leading-snug text-zinc-500 dark:text-zinc-400">{caption}</p>
    </div>
  );
}

// -- 6. codecs ----------------------------------------------------------------

function HardwarePill({ hardware }) {
  return hardware ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#0ca30c]/10 px-2 py-0.5 text-xs font-medium text-[#0a7d0a] ring-1 ring-[#0ca30c]/30 dark:text-[#3ec93e]">
      <span aria-hidden>✓</span> Hardware
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#d03b3b]/10 px-2 py-0.5 text-xs font-medium text-[#b83232] ring-1 ring-[#d03b3b]/30 dark:text-[#f08a8a]">
      <span aria-hidden>✗</span> Software
    </span>
  );
}

// ------------------------------------------------------------------- the page

export default function AnalyticsPage() {
  const [days, setDays] = useState(7);
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [settledKey, setSettledKey] = useState(null);

  // "Refreshing" is derived from which request has come back rather than from a
  // flag set inside the effect, which would cost an extra render every fetch.
  const requestKey = `${days}:${nonce}`;
  const pending = settledKey !== requestKey;

  useEffect(() => {
    let cancelled = false;
    const key = `${days}:${nonce}`;
    getAnalytics(days)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      })
      .catch((err) => {
        // The banner is additive: whatever was already on screen stays there.
        if (!cancelled) setError(err.message || "Could not load analytics");
      })
      .finally(() => {
        if (!cancelled) setSettledKey(key);
      });
    return () => {
      cancelled = true;
    };
  }, [days, nonce]);

  const refresh = useCallback(() => setNonce((v) => v + 1), []);

  // Poll while the tab is visible, so the Status column reflects who is
  // actually sharing rather than whoever was sharing when the page was opened.
  // Paused in a background tab: nobody is reading it, and a monitoring
  // dashboard left open all day should not keep the server busy for nothing.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  const quality = data?.quality || {};
  const bandwidth = data?.bandwidth || {};
  const peers = data?.peers || [];
  const codecs = data?.codecs || [];
  const timeline = data?.timeline || [];
  const bandwidthDaily = data?.bandwidthDaily || [];
  const samples = num(quality.samples);
  const hasTelemetry = samples > 0;

  const gbSentPeriod = bandwidthDaily.reduce((sum, r) => sum + num(r.gbSent), 0);
  const planShare = (gbSentPeriod / PLAN_GB_PER_MONTH) * 100;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8 font-sans sm:px-8">
      {/* 1. header + range ---------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
            What every screen-sharing machine is actually doing — how it encodes video,
            what is holding it back, and what that costs in bandwidth.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="Time range"
            className={`flex overflow-hidden rounded-lg ${RING}`}
          >
            {RANGES.map((range) => {
              const active = range === days;
              return (
                <button
                  key={range}
                  type="button"
                  onClick={() => setDays(range)}
                  aria-pressed={active}
                  aria-label={`Show the last ${range} ${range === 1 ? "day" : "days"}`}
                  className={`px-3 py-1.5 text-sm transition-colors ${FOCUS} ${
                    active
                      ? "bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "hover:bg-zinc-950/5 dark:hover:bg-white/5"
                  }`}
                >
                  {range}d
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={pending}
            aria-label="Reload analytics"
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors hover:bg-zinc-950/5 disabled:opacity-50 dark:hover:bg-white/5 ${RING} ${FOCUS}`}
          >
            {pending ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl bg-rose-500/10 p-4 text-sm text-rose-700 ring-1 ring-rose-600/25 dark:text-rose-300"
        >
          {error}
          {data && " — showing the last data that loaded."}
        </p>
      )}

      {!data && !error && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading analytics…</p>
      )}

      {data && (
        <div
          className={`flex flex-col gap-6 transition-opacity ${pending ? "opacity-60" : "opacity-100"}`}
        >
          {/* 9. empty state ---------------------------------------------- */}
          {!hasTelemetry ? (
            <section className={`rounded-2xl p-8 sm:p-10 ${RING}`} aria-labelledby="empty-heading">
              <h2 id="empty-heading" className="text-xl font-semibold tracking-tight">
                No telemetry yet
              </h2>
              <p className="mt-3 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
                Nothing was measured in the last {days} {days === 1 ? "day" : "days"}. Numbers
                appear here as soon as somebody shares a screen — each publisher reports its
                codec, frame rate, bitrate and encoder pressure every 30 seconds while it is
                sharing, so the first rows show up about half a minute into a session.
              </p>
              <ul className="mt-4 flex list-disc flex-col gap-1.5 pl-5 text-sm text-zinc-500 dark:text-zinc-400">
                <li>Open a screen room and start sharing, then come back here.</li>
                <li>Widen the range above if the sharing happened a while ago.</li>
                <li>
                  Watchers alone produce nothing — telemetry comes from the machine that is
                  publishing.
                </li>
              </ul>
            </section>
          ) : (
            <HealthVerdict peers={peers} />
          )}

          {/* 3. stat tiles ------------------------------------------------ */}
          {hasTelemetry && (
            <section aria-labelledby="stats-heading">
              <h2 id="stats-heading" className="sr-only">
                Headline numbers
              </h2>
              <dl
                className={`grid grid-cols-1 gap-px overflow-hidden rounded-xl bg-zinc-950/10 sm:grid-cols-2 lg:grid-cols-4 dark:bg-white/10 ${RING}`}
              >
                <StatTile
                  label="Bandwidth sent"
                  value={fmt(bandwidth.gbSent, 2)}
                  unit="GB"
                  caption="video pushed out of the server to watchers"
                />
                <StatTile
                  label="Average frame rate"
                  value={fmt(quality.avgFps, 1)}
                  unit="fps"
                  caption="below about 5 fps a screen share feels like a slideshow"
                />
                <StatTile
                  label="Average bitrate"
                  value={fmt(quality.avgKbps)}
                  unit="kbps"
                  caption="how much data each publisher spends per second"
                />
                <StatTile
                  label="Frames dropped"
                  value={fmt(quality.framesDropped)}
                  caption="frames the encoder threw away rather than send late"
                />
                <StatTile
                  label="Packets lost"
                  value={fmt(quality.packetsLost)}
                  caption="data that never arrived — a network problem, not a CPU one"
                />
                <StatTile
                  label="Average round trip"
                  value={fmt(quality.avgRttMs)}
                  unit="ms"
                  caption="time for a packet to reach the server and come back"
                />
                <StatTile
                  label="Idle share"
                  value={fmt(quality.idleShare)}
                  unit="%"
                  caption="time publishers were paused because nobody was watching"
                />
                <StatTile
                  label="Samples"
                  value={fmt(quality.samples)}
                  caption={`measurements behind this page — max resolution seen ${quality.maxResolution || "—"}`}
                />
              </dl>
            </section>
          )}

          {/* 4. timeline -------------------------------------------------- */}
          {hasTelemetry && (
            <Card>
              <SectionHead
                id="timeline-heading"
                title="Quality over time"
                hint="Bitrate and frame rate share one timeline but keep their own scales — forcing two units onto a single axis invents a correlation that is not in the data. Hover, or focus the chart and use the arrow keys."
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <LegendKey swatch={KBPS_SWATCH} label="kbps" />
                  <LegendKey swatch={FPS_SWATCH} label="fps" />
                  <LegendKey swatch={CPU_SWATCH} label="CPU-limited" shape="square" />
                </div>
              </SectionHead>

              {timeline.length === 0 ? (
                <ChartEmpty>
                  No hourly samples in this window — nobody was sharing a screen.
                </ChartEmpty>
              ) : (
                <>
                  <TimelineChart rows={timeline} />
                  {timeline.length === 1 && (
                    <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                      Only one hour has been measured so far, so there is a point rather than
                      a line.
                    </p>
                  )}
                  <DataTable label="the timeline">
                    <table className="w-full border-collapse text-left">
                      <caption className="sr-only">Hourly quality samples</caption>
                      <thead className="sticky top-0 bg-white dark:bg-zinc-950">
                        <tr className="border-b border-zinc-950/10 dark:border-white/10">
                          <th scope="col" className={TH}>
                            Hour
                          </th>
                          <th scope="col" className={TH}>
                            kbps
                          </th>
                          <th scope="col" className={TH}>
                            fps
                          </th>
                          <th scope="col" className={TH}>
                            Machines
                          </th>
                          <th scope="col" className={TH}>
                            CPU-limited
                          </th>
                          <th scope="col" className={TH}>
                            Dropped
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {timeline.map((row) => (
                          <tr
                            key={row.hour}
                            className="border-b border-zinc-950/5 last:border-0 dark:border-white/5"
                          >
                            <th scope="row" className={`${TD} font-normal`}>
                              {formatHour(row.hour, true)}
                            </th>
                            <td className={TD}>{fmt(row.avgKbps)}</td>
                            <td className={TD}>{fmt(row.avgFps, 1)}</td>
                            <td className={TD}>{fmt(row.peers)}</td>
                            <td className={TD}>
                              {fmt(row.cpuLimited)} / {fmt(row.samples)}
                            </td>
                            <td className={TD}>{fmt(row.framesDropped)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                </>
              )}
            </Card>
          )}

          {/* 5. bandwidth ------------------------------------------------- */}
          <Card>
            <SectionHead
              id="bandwidth-heading"
              title="Outbound transfer per day"
              hint={`The droplet's plan includes ${fmt(PLAN_GB_PER_MONTH)} GB of transfer a month.`}
            >
              <div className="text-right">
                <p className="text-sm font-medium tabular-nums">{fmt(gbSentPeriod, 2)} GB</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  this period · {fmt(planShare, 1)}% of the monthly plan
                </p>
              </div>
            </SectionHead>

            {bandwidthDaily.length === 0 ? (
              <ChartEmpty>No sessions in this window, so nothing was transferred.</ChartEmpty>
            ) : (
              <>
                <BandwidthChart rows={bandwidthDaily} />
                <DataTable label="daily transfer">
                  <table className="w-full border-collapse text-left">
                    <caption className="sr-only">Transfer per day</caption>
                    <thead className="sticky top-0 bg-white dark:bg-zinc-950">
                      <tr className="border-b border-zinc-950/10 dark:border-white/10">
                        <th scope="col" className={TH}>
                          Day
                        </th>
                        <th scope="col" className={TH}>
                          GB sent
                        </th>
                        <th scope="col" className={TH}>
                          GB received
                        </th>
                        <th scope="col" className={TH}>
                          Sessions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {bandwidthDaily.map((row) => (
                        <tr
                          key={row.day}
                          className="border-b border-zinc-950/5 last:border-0 dark:border-white/5"
                        >
                          <th scope="row" className={`${TD} font-normal`}>
                            {formatDay(row.day)}
                          </th>
                          <td className={TD}>{fmt(row.gbSent, 2)}</td>
                          <td className={TD}>{fmt(row.gbReceived, 2)}</td>
                          <td className={TD}>{fmt(row.sessions)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </>
            )}
          </Card>

          {/* 6. codecs ---------------------------------------------------- */}
          {hasTelemetry && (
            <Card>
              <SectionHead
                id="codec-heading"
                title="Codecs and encoders"
                hint="H264 is compressed by dedicated hardware on the graphics chip and costs almost nothing. VP8 is compressed in software and will pin a CPU core for as long as the share runs."
              />
              {codecs.length === 0 ? (
                <ChartEmpty>No codec information was reported in this window.</ChartEmpty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left">
                    <caption className="sr-only">
                      Codecs and encoders in use, with whether each is hardware accelerated
                    </caption>
                    <thead>
                      <tr className="border-b border-zinc-950/10 dark:border-white/10">
                        <th scope="col" className={TH}>
                          Codec
                        </th>
                        <th scope="col" className={TH}>
                          Encoder
                        </th>
                        <th scope="col" className={TH}>
                          Acceleration
                        </th>
                        <th scope="col" className={TH}>
                          Machines
                        </th>
                        <th scope="col" className={TH}>
                          Samples
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {codecs.map((c) => (
                        <tr
                          key={`${c.codec}-${c.encoder}`}
                          className={`border-b border-zinc-950/5 last:border-0 dark:border-white/5 ${
                            c.hardware ? "" : "bg-[#d03b3b]/[0.05]"
                          }`}
                        >
                          <th scope="row" className={`${TD} font-medium`}>
                            {c.codec || "—"}
                          </th>
                          <td className={`${TD} font-mono text-xs`}>{c.encoder || "—"}</td>
                          <td className={TD}>
                            <HardwarePill hardware={Boolean(c.hardware)} />
                          </td>
                          <td className={TD}>{fmt(c.peers)}</td>
                          <td className={TD}>{fmt(c.samples)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {/* 7. limiting factor ------------------------------------------- */}
          {hasTelemetry && (
            <Card>
              <SectionHead
                id="limit-heading"
                title="What was holding quality back"
                hint="Every sample says whether the browser had to lower quality, and why. This is the fastest way to tell a slow machine from a slow network."
              />
              <LimitingFactor limitedBy={data.limitedBy} />
            </Card>
          )}

          {/* 8. per-machine ----------------------------------------------- */}
          {hasTelemetry && (
            <Card>
              <SectionHead
                id="machines-heading"
                title="Per machine"
                hint="Sharing right now first, then the worst offenders. Tinted rows are the ones worth investigating; the figures cover the whole period, not just this moment."
              />
              {peers.length === 0 ? (
                <ChartEmpty>No named machines reported in this window.</ChartEmpty>
              ) : (
                <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
                  <table className="w-full min-w-[70rem] border-collapse text-left">
                    <caption className="sr-only">
                      Per-machine encoding and quality breakdown, worst first
                    </caption>
                    <thead>
                      <tr className="border-b border-zinc-950/10 dark:border-white/10">
                        <th scope="col" className={TH}>
                          Status
                        </th>
                        <th scope="col" className={TH}>
                          Machine
                        </th>
                        <th scope="col" className={TH}>
                          Codec
                        </th>
                        <th scope="col" className={TH}>
                          Encoder
                        </th>
                        <th scope="col" className={TH}>
                          Resolution
                        </th>
                        <th scope="col" className={TH}>
                          fps
                        </th>
                        <th scope="col" className={TH}>
                          kbps
                        </th>
                        <th scope="col" className={TH}>
                          Software
                        </th>
                        <th scope="col" className={TH}>
                          CPU-limited
                        </th>
                        <th scope="col" className={TH}>
                          Dropped
                        </th>
                        <th scope="col" className={TH}>
                          Lost
                        </th>
                        <th scope="col" className={TH}>
                          RTT
                        </th>
                        <th scope="col" className={TH}>
                          Last seen
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {peers.map((p) => {
                        const problem = num(p.softwarePct) > 50 || num(p.cpuLimitedPct) > 20;
                        return (
                          <tr
                            key={`${p.identity}-${p.roomId}`}
                            className={`border-b border-zinc-950/5 last:border-0 dark:border-white/5 ${
                              problem ? "bg-[#d03b3b]/[0.06]" : ""
                            }`}
                          >
                            <td className={TD}>
                              <LivePill live={p.live} />
                            </td>
                            <th scope="row" className={`${TD} font-medium`}>
                              {p.identity}
                            </th>
                            <td className={TD}>{p.codec || "—"}</td>
                            <td className={`${TD} font-mono text-xs`}>{p.encoder || "—"}</td>
                            <td className={TD}>{p.resolution || "—"}</td>
                            <td className={TD}>{fmt(p.avgFps, 1)}</td>
                            <td className={TD}>{fmt(p.avgKbps)}</td>
                            <td className={TD}>
                              <span
                                className={
                                  num(p.softwarePct) > 50
                                    ? "font-medium text-[#b83232] dark:text-[#f08a8a]"
                                    : ""
                                }
                              >
                                {fmt(p.softwarePct)}%
                              </span>
                            </td>
                            <td className={TD}>
                              <span
                                className={
                                  num(p.cpuLimitedPct) > 20
                                    ? "font-medium text-[#b83232] dark:text-[#f08a8a]"
                                    : ""
                                }
                              >
                                {fmt(p.cpuLimitedPct)}%
                              </span>
                            </td>
                            <td className={TD}>{fmt(p.framesDropped)}</td>
                            <td className={TD}>{fmt(p.packetsLost)}</td>
                            <td className={TD}>{fmt(p.avgRttMs)} ms</td>
                            <td className={`${TD} text-zinc-500 dark:text-zinc-400`}>
                              {formatDate(p.lastSeen)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </main>
  );
}

/**
 * Whether this machine is connected at this moment, taken from live room state
 * rather than the age of its last sample — telemetry is 30 seconds apart, so a
 * timestamp would call a perfectly healthy machine offline between reports.
 */
function LivePill({ live }) {
  if (live) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/25 dark:text-emerald-400 dark:ring-emerald-400/25">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        Sharing
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs text-zinc-500 ring-1 ring-zinc-950/10 dark:text-zinc-400 dark:ring-white/10">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-600" />
      Offline
    </span>
  );
}
