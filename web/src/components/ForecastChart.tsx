import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, type TooltipProps, XAxis, YAxis } from "recharts";
import type { CameraForecastView } from "../api/types";
import { useThemeColors } from "../hooks/themeColors";

interface Point {
  t: number;
  measured?: number;
  projected?: number;
}

function ChartTooltip({ active, payload }: TooltipProps<number, string>) {
  const p = payload?.[0]?.payload as Point | undefined;
  if (!active || !p) return null;
  const isProjection = p.measured === undefined;
  const value = p.measured ?? p.projected;
  return (
    <div className="rounded-md border border-line bg-raised px-3 py-2 text-xs shadow-md">
      <div className="text-sm font-semibold text-ink">{value === undefined ? "—" : `${value.toFixed(1)}%`}</div>
      <div className="text-ink-secondary">{isProjection ? "Projected (estimate)" : "Measured"}</div>
      <div className="mt-0.5 text-ink-muted">{new Date(p.t).toLocaleString()}</div>
    </div>
  );
}

/**
 * Measured storage use (solid, filled) followed by the linear projection (dashed, same hue), so
 * actual and predicted data are told apart by line style, not colour. Thresholds are hairlines
 * labelled in muted ink; "Now" marks the most recent measurement.
 */
export function ForecastChart({ data }: { data: CameraForecastView }) {
  const c = useThemeColors();
  const points: Point[] = [
    ...data.actual.map((p) => ({ t: new Date(p.t).getTime(), measured: p.usedPercentage })),
    ...data.projected.slice(1).map((p) => ({ t: new Date(p.t).getTime(), projected: p.usedPercentage })),
  ];
  const last = data.actual.at(-1);
  // The projection starts exactly at the last measurement so the two lines join.
  if (last && data.projected.length > 1) {
    const i = points.findIndex((p) => p.t === new Date(last.t).getTime());
    if (i >= 0) points[i] = { ...points[i]!, projected: last.usedPercentage };
  }
  if (data.actual.length < 2) {
    return (
      <div className="flex h-72 items-center justify-center text-center text-sm text-ink-secondary">
        Not enough measurements to draw a chart yet.
      </div>
    );
  }
  const now = last ? new Date(last.t).getTime() : undefined;
  const { warningThreshold: warning, criticalThreshold: critical } = data.camera;
  const span = (points.at(-1)!.t - points[0]!.t) / 86_400_000;
  const fmt = (t: number) =>
    span <= 2 ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-ink-secondary" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke={c.accent} strokeWidth="2" /></svg>Measured
        </span>
        {data.projected.length > 1 && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke={c.accent} strokeWidth="2" strokeDasharray="4 3" /></svg>Projected (estimate)
          </span>
        )}
      </div>
      <div
        className="h-72 w-full"
        role="img"
        aria-label={`Storage used: measured over ${data.forecast.period?.days ?? 0} days${data.projected.length > 1 ? `, projected ${data.projected.length - 1} days ahead` : ""}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke={c.line} strokeWidth={1} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={fmt}
              stroke={c.lineStrong}
              tick={{ fill: c.inkMuted, fontSize: 11 }}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v) => `${v}%`}
              stroke={c.lineStrong}
              tick={{ fill: c.inkMuted, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={44}
            />
            <ReferenceLine y={warning} stroke={c.warn} strokeWidth={1} label={{ value: `Warning ${warning}%`, position: "insideBottomRight", fill: c.inkMuted, fontSize: 11 }} />
            <ReferenceLine y={critical} stroke={c.bad} strokeWidth={1} label={{ value: `Critical ${critical}%`, position: "insideBottomRight", fill: c.inkMuted, fontSize: 11 }} />
            {now !== undefined && data.projected.length > 1 && (
              <ReferenceLine x={now} stroke={c.lineStrong} strokeWidth={1} label={{ value: "Now", position: "insideBottomLeft", fill: c.inkMuted, fontSize: 11 }} />
            )}
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: c.inkMuted, strokeWidth: 1 }} isAnimationActive={false} />
            <Area
              type="linear"
              dataKey="measured"
              stroke={c.accent}
              strokeWidth={2}
              fill={c.accent}
              fillOpacity={0.1}
              connectNulls
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, fill: c.accent, stroke: c.surface, strokeWidth: 2 }}
            />
            <Line
              type="linear"
              dataKey="projected"
              stroke={c.accent}
              strokeWidth={2}
              strokeDasharray="6 4"
              connectNulls
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, fill: c.surface, stroke: c.accent, strokeWidth: 2 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
