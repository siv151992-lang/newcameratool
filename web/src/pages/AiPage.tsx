import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Activity, AlertTriangle, Bot, CircleStop, Download, FileText, Gauge, LineChart, Send, Sparkles, TrendingUp, WifiOff } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import type { AssistantAnswer, CameraForecastView, CameraInsight, ChatMessage, FleetInsights, Forecast, MonitoringReport, RecommendedAction } from "../api/types";
import { ForecastChart } from "../components/ForecastChart";
import { Markdown } from "../components/Markdown";
import { Button, Card, EmptyState, ErrorMessage, PageHeader, Select, Spinner, Textarea } from "../components/ui";
import { useAiStatus } from "../hooks/ai";
import { useAuth } from "../hooks/auth";
import { formatBytes, relativeTime } from "../lib/format";

const isoOf = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(1)}%`);
const days = (n: number | null) => (n === null ? "—" : n === 0 ? "Reached" : n < 1 ? "< 1 day" : `${Math.round(n)} days`);

const PRIORITY_STYLE: Record<RecommendedAction["priority"], string> = {
  critical: "bg-bad/10 border-bad/35",
  high: "bg-warn/15 border-warn/40",
  medium: "bg-accent/10 border-accent/30",
  low: "bg-unknown/10 border-unknown/30",
};
function PriorityBadge({ priority }: { priority: RecommendedAction["priority"] }) {
  return <span className={clsx("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium capitalize text-ink", PRIORITY_STYLE[priority])}>{priority}</span>;
}

const GRADE_STYLE = { good: "text-good", fair: "text-warn", poor: "text-bad", unknown: "text-unknown" } as const;

export function AiPage() {
  const status = useAiStatus();
  if (status.isLoading) return <Spinner label="Loading AI Mode" />;
  if (status.error) return <ErrorMessage error={status.error} />;
  if (!status.data?.enabled) {
    return (
      <>
        <PageHeader title="AI Mode" />
        <EmptyState
          icon={<Sparkles className="h-8 w-8" />}
          title="AI Mode is turned off"
          description="Monitoring, alerts and camera management keep working as usual. An administrator can turn AI Mode on in Settings → AI Mode."
        />
      </>
    );
  }
  const tabs = [
    { to: "/ai", label: "Insights", icon: <Gauge className="h-4 w-4" />, end: true },
    { to: "/ai/forecasts", label: "Storage forecasts", icon: <LineChart className="h-4 w-4" /> },
    { to: "/ai/assistant", label: "Assistant", icon: <Bot className="h-4 w-4" /> },
    { to: "/ai/reports", label: "Reports", icon: <FileText className="h-4 w-4" /> },
  ];
  return (
    <>
      <PageHeader
        title="AI Mode"
        description="Forecasts, anomalies and recommendations computed from your monitoring history, plus an assistant that answers from live data. Rule-based monitoring and alerts work independently of this page."
      />
      <nav aria-label="AI Mode sections" className="mb-5 flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              clsx(
                "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium",
                isActive ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink",
              )
            }
          >
            {t.icon}
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<InsightsTab />} />
        <Route path="forecasts" element={<ForecastsTab />} />
        <Route path="assistant" element={<AssistantTab available={status.data.assistant.available} reason={status.data.assistant.reason} />} />
        <Route path="reports" element={<ReportsTab assistantAvailable={status.data.assistant.available} />} />
        <Route path="*" element={<Navigate to="/ai" replace />} />
      </Routes>
    </>
  );
}

function useInsights() {
  return useQuery({ queryKey: ["ai", "insights"], queryFn: () => api<FleetInsights>("/ai/insights"), refetchInterval: 60_000 });
}

function Tile({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2 text-sm text-ink-secondary">
        <span>{label}</span>
        <span aria-hidden>{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-ink">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}

function ActionList({ actions, empty }: { actions: RecommendedAction[]; empty: string }) {
  if (actions.length === 0) return <p className="px-4 py-3 text-sm text-ink-secondary">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {actions.map((a, i) => (
        <li key={`${a.cameraId}-${i}`} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
          <PriorityBadge priority={a.priority} />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">{a.action}</p>
            <p className="text-ink-secondary">{a.reason}</p>
          </div>
          <Link to={`/cameras/${a.cameraId}`} className="text-sm font-medium text-accent-ink hover:underline">
            {a.cameraName}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function InsightsTab() {
  const insights = useInsights();
  if (insights.isLoading) return <Spinner label="Analysing monitoring history" />;
  if (insights.error) return <ErrorMessage error={insights.error} />;
  const d = insights.data!;
  const s = d.summary;
  const icon = "h-4 w-4";
  const attention = d.cameras
    .filter((c) => c.camera.monitoringEnabled && (c.health.grade === "fair" || c.health.grade === "poor"))
    .sort((a, b) => a.health.score - b.health.score);
  const anomalies = d.cameras.flatMap((c) => c.anomalies.map((a) => ({ ...a, camera: c })));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Tile label="Average health" value={s.averageHealth === null ? "—" : `${s.averageHealth}/100`} hint={`${s.monitored} monitored cameras`} icon={<Activity className={`${icon} text-accent`} />} />
        <Tile label="Critical within 7 days" value={s.criticalWithin7Days} hint="Estimated from usage trends" icon={<TrendingUp className={`${icon} text-warn`} />} />
        <Tile label="Anomalies" value={s.anomalies} hint={`From the last ${d.historyDays} days`} icon={<AlertTriangle className={`${icon} text-warn`} />} />
        <Tile label="Not recording" value={s.notRecording} icon={<CircleStop className={`${icon} text-warn`} />} />
        <Tile label="Offline" value={s.offline} icon={<WifiOff className={`${icon} text-bad`} />} />
      </div>

      <Card title="Recommended actions" actions={<span className="text-xs text-ink-muted">Updated {relativeTime(d.generatedAt)}</span>}>
        <ActionList actions={d.actions.slice(0, 12)} empty="Nothing needs attention right now." />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Cameras needing attention">
          {attention.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-secondary">Every monitored camera has a good health score.</p>
          ) : (
            <ul className="divide-y divide-line">
              {attention.map((c) => (
                <li key={c.camera.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                  <span className={clsx("tabular w-14 shrink-0 text-lg font-semibold", GRADE_STYLE[c.health.grade])} title={`Health ${c.health.grade}`}>
                    {c.health.score}
                  </span>
                  <div className="min-w-0">
                    <Link to={c.link} className="font-medium text-ink hover:underline">{c.camera.name}</Link>{" "}
                    <span className="text-ink-muted">{c.camera.host}</span>
                    <p className="text-ink-secondary">{c.health.factors.map((f) => f.label).join(" · ")}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Anomalies">
          {anomalies.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-secondary">No unusual behaviour detected.</p>
          ) : (
            <ul className="divide-y divide-line">
              {anomalies.map((a, i) => (
                <li key={i} className="px-4 py-3 text-sm">
                  <p>
                    <span className="font-medium text-ink">{a.title}</span> ·{" "}
                    <Link to={a.camera.link} className="text-accent-ink hover:underline">{a.camera.camera.name}</Link>{" "}
                    <span className="text-xs capitalize text-ink-muted">({a.severity})</span>
                  </p>
                  <p className="text-ink-secondary">{a.explanation}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p className="text-xs text-ink-muted">
        Health scores, forecasts and anomalies are calculated by fixed, transparent rules from the stored measurements; they do not use the AI service.
      </p>
    </div>
  );
}

const STATUS_TEXT: Record<Forecast["status"], string> = {
  insufficient_data: "Not enough history",
  growing: "Growing",
  stable: "Stable",
  decreasing: "Decreasing",
  full_overwriting: "Full (overwriting)",
};

function projection(f: Forecast, h: number) {
  const p = f.projections.find((x) => x.horizonDays === h);
  return p ? pct(p.usedPercentage) : "—";
}

/** Summary, chart and caveats of one camera's forecast; also shown on the camera page. */
export function CameraForecastPanel({ cameraId }: { cameraId: string }) {
  const q = useQuery({ queryKey: ["ai", "forecast", cameraId], queryFn: () => api<CameraForecastView>(`/ai/cameras/${cameraId}/forecast`) });
  if (q.isLoading) return <Spinner label="Loading forecast" />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const d = q.data!;
  const f = d.forecast;
  const growth = f.growthPercentPerDay;
  const stats: [string, ReactNode][] = [
    ["Used now", f.current ? `${pct(f.current.usedPercentage)} · ${formatBytes(f.current.usedBytes)} of ${formatBytes(f.current.totalBytes)}` : "—"],
    ["Free now", formatBytes(f.current?.freeBytes)],
    ["Growth", growth === null ? "—" : `${growth >= 0 ? "+" : ""}${growth.toFixed(2)} points/day${f.growthBytesPerDay !== null ? ` (${formatBytes(Math.abs(f.growthBytesPerDay))}/day)` : ""}`],
    [`To warning (${d.camera.warningThreshold}%)`, days(f.daysToWarning)],
    [`To critical (${d.camera.criticalThreshold}%)`, days(f.daysToCritical)],
    ["In 24 h / 7 d / 30 d", `${projection(f, 1)} / ${projection(f, 7)} / ${projection(f, 30)}`],
    ["Confidence", f.confidence ? <span className="capitalize">{f.confidence}{f.rSquared !== null ? ` (fit R² ${f.rSquared})` : ""}</span> : "—"],
    ["Based on", f.period ? `${f.period.points} readings over ${f.period.days} days` : "—"],
    ["Last measurement", f.current ? relativeTime(isoOf(f.current.measuredAt)) : "—"],
  ];
  return (
    <div className="space-y-4 p-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        {stats.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-ink-muted">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <ForecastChart data={d} />
      {f.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-secondary">
          {f.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <p className="text-xs text-ink-muted">Projections are statistical estimates (a straight-line trend through recent measurements), not guarantees.</p>
    </div>
  );
}

function ForecastsTab() {
  const insights = useInsights();
  const [selected, setSelected] = useState<string | null>(null);
  const rows = (insights.data?.cameras ?? [])
    .filter((c) => c.camera.monitoringEnabled)
    .sort((a, b) => (a.forecast.daysToCritical ?? Infinity) - (b.forecast.daysToCritical ?? Infinity) || a.camera.name.localeCompare(b.camera.name));
  useEffect(() => {
    if (!selected && rows[0]) setSelected(rows[0].camera.id);
  }, [rows, selected]);
  if (insights.isLoading) return <Spinner label="Calculating forecasts" />;
  if (insights.error) return <ErrorMessage error={insights.error} />;
  if (rows.length === 0) return <EmptyState title="No monitored cameras" description="Forecasts appear once cameras have storage history." />;
  const current = rows.find((r) => r.camera.id === selected);
  return (
    <div className="space-y-5">
      <Card
        title="Storage forecasts"
        actions={
          <span className="text-xs text-ink-muted">
            {insights.data && insights.data.camerasShown < insights.data.camerasTotal
              ? `Showing the ${rows.length} cameras closest to critical or needing attention, of ${insights.data.summary.monitored} monitored. `
              : ""}
            Select a camera to see its chart
          </span>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-ink-secondary">
              <tr>
                {["Camera", "Used", "Trend", "Growth / day", "To warning", "To critical", "+24 h", "+7 d", "+30 d", "Confidence", "Last measurement"].map((h, i) => (
                  <th key={h} scope="col" className={clsx("whitespace-nowrap px-3 py-2 font-medium", i >= 1 && i !== 2 && i !== 9 && "text-right")}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r: CameraInsight) => {
                const f = r.forecast;
                const active = r.camera.id === selected;
                return (
                  <tr
                    key={r.camera.id}
                    className={clsx("cursor-pointer border-b border-line last:border-0", active ? "bg-accent/10" : "hover:bg-page/60")}
                    onClick={() => setSelected(r.camera.id)}
                  >
                    <td className="px-3 py-2">
                      <button className="text-left font-medium text-ink hover:underline" onClick={() => setSelected(r.camera.id)} aria-pressed={active}>
                        {r.camera.name}
                      </button>
                      <div className="text-xs text-ink-muted">{r.camera.host}</div>
                    </td>
                    <td className="tabular px-3 py-2 text-right">{pct(r.camera.usedPercentage)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-secondary">{STATUS_TEXT[f.status]}</td>
                    <td className="tabular whitespace-nowrap px-3 py-2 text-right">{f.growthPercentPerDay === null ? "—" : `${f.growthPercentPerDay >= 0 ? "+" : ""}${f.growthPercentPerDay.toFixed(2)} pts`}</td>
                    <td className="tabular whitespace-nowrap px-3 py-2 text-right">{days(f.daysToWarning)}</td>
                    <td className="tabular whitespace-nowrap px-3 py-2 text-right font-medium">{days(f.daysToCritical)}</td>
                    <td className="tabular px-3 py-2 text-right">{projection(f, 1)}</td>
                    <td className="tabular px-3 py-2 text-right">{projection(f, 7)}</td>
                    <td className="tabular px-3 py-2 text-right">{projection(f, 30)}</td>
                    <td className="px-3 py-2 capitalize text-ink-secondary">{f.confidence ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-ink-secondary">{f.current ? relativeTime(isoOf(f.current.measuredAt)) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {current && (
        <Card title={<span>Forecast: <Link to={current.link} className="hover:underline">{current.camera.name}</Link></span>}>
          <CameraForecastPanel cameraId={current.camera.id} />
        </Card>
      )}
    </div>
  );
}

const EXAMPLES = [
  "Which cameras need immediate attention?",
  "Which cameras are offline right now?",
  "Which cameras are likely to run out of storage in the next seven days?",
  "Which cameras have less than 20% free storage?",
  "Has any camera shown unusual storage consumption?",
  "Summarize all camera incidents from the last 24 hours.",
  "Compare the storage usage of all cameras.",
];

function AssistantTab({ available, reason }: { available: boolean; reason?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [lookups, setLookups] = useState<Record<number, string[]>>({});
  const endRef = useRef<HTMLDivElement>(null);
  const ask = useMutation({
    mutationFn: (history: ChatMessage[]) => api<AssistantAnswer>("/ai/assistant", { method: "POST", body: { messages: history } }),
    onSuccess: (res, history) => {
      setLookups((l) => ({ ...l, [history.length]: [...new Set(res.toolCalls.map((t) => t.name))] }));
      setMessages([...history, { role: "assistant", content: res.answer }]);
    },
  });
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [messages, ask.isPending]);

  const send = (text: string) => {
    const q = text.trim();
    if (!q || ask.isPending) return;
    // Only the last 9 exchanges are sent, which keeps requests small.
    const history = [...messages, { role: "user" as const, content: q }].slice(-19);
    setMessages(history);
    setDraft("");
    ask.mutate(history);
  };

  if (!available) {
    return (
      <EmptyState
        icon={<Bot className="h-8 w-8" />}
        title="The assistant is not configured"
        description={`${reason ?? "No AI service is configured."} The insights, forecasts and reports tabs work without it.`}
      />
    );
  }
  return (
    <Card>
      <div className="flex min-h-[420px] flex-col">
        <div className="flex-1 space-y-4 p-4" aria-live="polite">
          {messages.length === 0 && (
            <div>
              <p className="text-sm text-ink-secondary">Ask about cameras, storage, alerts and incidents. Answers come from the live monitoring data. For example:</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {EXAMPLES.map((e) => (
                  <button key={e} onClick={() => send(e)} className="rounded-full border border-line-strong px-3 py-1 text-sm text-ink hover:bg-page">
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <p className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-accent/10 px-3 py-2 text-sm text-ink">{m.content}</p>
              </div>
            ) : (
              <div key={i} className="max-w-[90%]">
                <div className="rounded-lg border border-line bg-raised px-3 py-2">
                  <Markdown text={m.content} />
                </div>
                {lookups[i] && lookups[i]!.length > 0 && (
                  <p className="mt-1 text-xs text-ink-muted">Looked up: {lookups[i]!.map((n) => n.replace(/^get_|_/g, (x) => (x === "_" ? " " : ""))).join(", ")}</p>
                )}
              </div>
            ),
          )}
          {ask.isPending && <p className="text-sm text-ink-secondary">Looking at the monitoring data…</p>}
          {ask.error && <ErrorMessage error={ask.error} />}
          <div ref={endRef} />
        </div>
        <form
          className="flex items-end gap-2 border-t border-line p-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <Textarea
            aria-label="Ask the monitoring assistant"
            className="!font-sans !text-sm"
            rows={2}
            maxLength={4000}
            placeholder="Ask a question about your cameras…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(draft);
              }
            }}
          />
          <div className="flex flex-col gap-1">
            <Button type="submit" variant="primary" icon={<Send className="h-4 w-4" />} loading={ask.isPending} disabled={!draft.trim()}>
              Ask
            </Button>
            {messages.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => { setMessages([]); setLookups({}); ask.reset(); }}>
                Clear
              </Button>
            )}
          </div>
        </form>
        <p className="border-t border-line px-4 py-2 text-xs text-ink-muted">
          AI-generated answers can be wrong: check important facts on the camera pages. Forecasts are estimates. Camera names, IP addresses and
          monitoring data (never passwords) are sent to the AI service to answer.
        </p>
      </div>
    </Card>
  );
}

function ReportsTab({ assistantAvailable }: { assistantAvailable: boolean }) {
  const { can } = useAuth();
  const [period, setPeriod] = useState<"24h" | "7d">("24h");
  const report = useQuery({ queryKey: ["ai", "report", period], queryFn: () => api<MonitoringReport>(`/ai/report?period=${period}`) });
  const summary = useMutation({ mutationFn: () => api<MonitoringReport>("/ai/report/summary", { method: "POST", body: { period } }) });
  useEffect(() => summary.reset(), [period]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = summary.data ?? report.data;
  const download = () => {
    if (!shown) return;
    const text = shown.aiSummary ? `${shown.markdown.split("\n")[0]}\n\n## AI summary\n\n${shown.aiSummary}\n${shown.markdown.slice(shown.markdown.indexOf("\n"))}` : shown.markdown;
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `cctv-report-${period}-${shown.generatedAt.slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Report period" className="w-auto" value={period} onChange={(e) => setPeriod(e.target.value as "24h" | "7d")}>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
        </Select>
        <Button onClick={() => report.refetch()} loading={report.isFetching}>Refresh</Button>
        {assistantAvailable && can("cameras:read") && (
          <Button icon={<Sparkles className="h-4 w-4" />} onClick={() => summary.mutate()} loading={summary.isPending} disabled={!!summary.data}>
            Add AI summary
          </Button>
        )}
        <Button icon={<Download className="h-4 w-4" />} onClick={download} disabled={!shown}>Download (.md)</Button>
      </div>
      <ErrorMessage error={report.error ?? summary.error} />
      {report.isLoading && <Spinner label="Building report" />}
      {shown && (
        <Card>
          <div className="space-y-4 p-5">
            {shown.aiSummary && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-secondary"><Sparkles className="h-3.5 w-3.5" aria-hidden />AI summary</p>
                <Markdown text={shown.aiSummary} />
              </div>
            )}
            <Markdown text={shown.markdown} />
          </div>
        </Card>
      )}
    </div>
  );
}
