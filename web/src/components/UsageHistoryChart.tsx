import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import type { HistoryCheck } from "../api/types";
import { useThemeColors } from "../hooks/themeColors";
import { formatBytes } from "../lib/format";

interface Point {
  t: number;
  usage: number | null;
  used: number | null;
  total: number | null;
}

function ChartTooltip({ active, payload }: TooltipProps<number, string>) {
  const p = payload?.[0]?.payload as Point | undefined;
  if (!active || !p) return null;
  return (
    <div className="rounded-md border border-line bg-raised px-3 py-2 text-xs shadow-md">
      <div className="text-sm font-semibold text-ink">{p.usage === null ? "No data" : `${p.usage.toFixed(1)}%`}</div>
      {p.used !== null && (
        <div className="text-ink-secondary">
          {formatBytes(p.used)} of {formatBytes(p.total)}
        </div>
      )}
      {p.usage === null && <div className="text-ink-secondary">Check failed</div>}
      <div className="mt-0.5 text-ink-muted">{new Date(p.t).toLocaleString()}</div>
    </div>
  );
}

/**
 * Single-series storage utilisation over time. Failed checks leave honest gaps (no interpolation).
 * Warning/critical thresholds are hairline reference lines labelled in muted ink.
 */
export function UsageHistoryChart({ checks, warning, critical, hours }: { checks: HistoryCheck[]; warning: number; critical: number; hours: number }) {
  const c = useThemeColors();
  const data: Point[] = [...checks]
    .reverse()
    .map((k) => ({ t: new Date(k.checkedAt).getTime(), usage: k.usedPercentage, used: k.usedBytes, total: k.totalBytes }));
  const measured = data.filter((d) => d.usage !== null);
  if (measured.length < 2) {
    const only = measured[0];
    return (
      <div className="flex h-64 flex-col items-center justify-center text-center text-sm">
        <p className="font-medium text-ink">{only ? `${only.usage!.toFixed(1)}% used at ${new Date(only.t).toLocaleString()}` : "No successful readings in this period"}</p>
        <p className="mt-1 text-ink-secondary">The chart appears once there are at least two successful checks.</p>
      </div>
    );
  }
  const fmt = (t: number) =>
    hours <= 24
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div className="h-64 w-full" role="img" aria-label={`Storage usage over the last ${hours} hours`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
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
          <ReferenceLine y={warning} stroke={c.warn} strokeWidth={1} label={{ value: `Warning ${warning}%`, position: "insideTopRight", fill: c.inkMuted, fontSize: 11 }} />
          <ReferenceLine y={critical} stroke={c.bad} strokeWidth={1} label={{ value: `Critical ${critical}%`, position: "insideTopRight", fill: c.inkMuted, fontSize: 11 }} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: c.inkMuted, strokeWidth: 1 }} isAnimationActive={false} />
          <Area
            type="linear"
            dataKey="usage"
            stroke={c.accent}
            strokeWidth={2}
            fill={c.accent}
            fillOpacity={0.1}
            connectNulls={false}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 4, fill: c.accent, stroke: c.surface, strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
