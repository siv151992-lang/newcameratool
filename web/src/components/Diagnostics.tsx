import clsx from "clsx";
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import type { ConnectionResult } from "../api/types";
import { formatBytes, formatPercent } from "../lib/format";

const ICONS = {
  passed: <CheckCircle2 className="h-4 w-4 text-good" aria-hidden />,
  failed: <XCircle className="h-4 w-4 text-bad" aria-hidden />,
  warning: <AlertTriangle className="h-4 w-4 text-warn" aria-hidden />,
  skipped: <CircleDashed className="h-4 w-4 text-unknown" aria-hidden />,
};
const STATUS_TEXT = { passed: "Passed", failed: "Failed", warning: "Warning", skipped: "Skipped" };

/** Step-by-step Test Connection results: reachability → authentication → API → storage. */
export function Diagnostics({ result }: { result: ConnectionResult }) {
  return (
    <div className="space-y-3" aria-live="polite">
      <div
        className={clsx(
          "rounded-md border px-3 py-2 text-sm",
          result.ok ? "border-good/40 bg-good/10" : result.reachable ? "border-warn/50 bg-warn/10" : "border-bad/40 bg-bad/10",
        )}
      >
        <strong>
          {result.ok
            ? "Connection successful — storage information retrieved."
            : result.reachable
              ? "The camera is reachable, but the check did not complete."
              : "The camera could not be reached."}
        </strong>
        {result.error && <div className="mt-0.5 text-ink-secondary">{result.error.message}</div>}
      </div>
      <ol className="space-y-2">
        {result.steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5">{ICONS[s.status]}</span>
            <div>
              <span className="font-medium">{s.label}</span>
              <span className="text-ink-muted"> · {STATUS_TEXT[s.status]}</span>
              <div className="text-ink-secondary">{s.message}</div>
            </div>
          </li>
        ))}
      </ol>
      {result.storage && result.storage.totalBytes !== undefined && (
        <dl className="grid grid-cols-2 gap-2 rounded-md border border-line p-3 text-sm sm:grid-cols-4">
          <div><dt className="text-ink-muted">Total</dt><dd className="tabular font-medium">{formatBytes(result.storage.totalBytes)}</dd></div>
          <div><dt className="text-ink-muted">Used</dt><dd className="tabular font-medium">{formatBytes(result.storage.usedBytes)}</dd></div>
          <div><dt className="text-ink-muted">Free</dt><dd className="tabular font-medium">{formatBytes(result.storage.freeBytes)}</dd></div>
          <div><dt className="text-ink-muted">Used %</dt><dd className="tabular font-medium">{formatPercent(result.storage.usedPercentage)}</dd></div>
        </dl>
      )}
    </div>
  );
}
