import clsx from "clsx";
import { CheckCircle2, Download, FileUp, ShieldCheck, XCircle } from "lucide-react";
import Papa from "papaparse";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ImportRow, ImportRowResult, ImportValidation } from "../api/types";
import { Button, Card, Checkbox, ConfirmDialog, ErrorMessage, Field, Input, PageHeader, Select } from "../components/ui";
import { useInvalidateCameras } from "../hooks/cameras";
import { readTabText, readXlsx, toImportRecords, type ImportRecord } from "../lib/spreadsheet";

const COLUMNS = ["name", "ip", "brand", "model", "username", "password", "location", "port", "protocol"] as const;
const REQUIRED = ["name", "ip", "brand"];
const MAX_ROWS = 500;
const BATCH = 10;
type Step = "upload" | "review" | "importing" | "done";

interface Options {
  useShared: boolean;
  sharedUsername: string;
  sharedPassword: string;
  sharedMode: "missing" | "all";
  monitoringEnabled: boolean;
  testConnectivity: boolean;
  testConcurrency: number;
  skipFailedTests: boolean;
}

const EDITABLE: (keyof ImportRow)[] = ["name", "ip", "brand", "port", "protocol", "username", "password"];

function buildOptions(o: Options) {
  return {
    sharedCredentials: o.useShared && o.sharedUsername && o.sharedPassword ? { username: o.sharedUsername, password: o.sharedPassword } : undefined,
    sharedCredentialsMode: o.sharedMode,
    monitoringEnabled: o.monitoringEnabled,
    testConnectivity: o.testConnectivity,
    testConcurrency: o.testConcurrency,
    skipFailedTests: o.skipFailedTests,
  };
}

export function ImportPage() {
  const invalidate = useInvalidateCameras();
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [sourceFormat, setSourceFormat] = useState<"app" | "bosch">("app");
  // Rows (including any passwords) live only in this component's memory and are cleared when done.
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [validation, setValidation] = useState<ImportValidation[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<ImportRowResult[]>([]);
  const [opts, setOpts] = useState<Options>({
    useShared: false, sharedUsername: "admin", sharedPassword: "", sharedMode: "missing",
    monitoringEnabled: true, testConnectivity: false, testConcurrency: 3, skipFailedTests: false,
  });

  // Cameras found by a network scan: their rows (no passwords), ready for shared credentials.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const scanRows = (location.state as { scanRows?: ImportRow[] } | null)?.scanRows;
    if (!scanRows?.length) return;
    setRows(scanRows);
    setFileName(`Network scan: ${scanRows.length} camera${scanRows.length === 1 ? "" : "s"}`);
    setOpts((o) => ({ ...o, useShared: true, sharedMode: "all", testConnectivity: true }));
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  const reset = () => {
    setRows([]);
    setValidation(null);
    setResults([]);
    setProgress(0);
    setFileName("");
    setParseError(null);
    setError(null);
    setOpts((o) => ({ ...o, sharedPassword: "" }));
    setStep("upload");
    if (fileInput.current) fileInput.current.value = "";
  };

  /** Rows from a spreadsheet (Excel, or tab-separated text such as Bosch Project Assistant's export). */
  const takeRecords = (records: ImportRecord[]) => {
    if (records.length === 0) return setParseError("The file contains no camera rows.");
    if (records.length > MAX_ROWS) return setParseError(`The file has ${records.length} rows; import at most ${MAX_ROWS} at a time.`);
    const missing = records.findIndex((r) => !r.name || !r.ip);
    if (missing >= 0) return setParseError(`Row ${missing + 2} has no camera name or IP address.`);
    setRows(records.map((r, i) => ({ row: i + 2, ...r })));
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    setValidation(null);
    setFileName(file.name);
    const ext = file.name.toLowerCase().split(".").pop();
    if (ext === "xlsx" || ext === "txt" || ext === "tsv") {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // The first sheet with a camera list (a Bosch template starts with an instructions sheet).
        const sheets = ext === "xlsx" ? await readXlsx(bytes) : [{ name: file.name, rows: readTabText(bytes) }];
        const found = sheets.map((s) => toImportRecords(s.rows)).find((r) => r !== null);
        if (!found) {
          return setParseError("No camera list found: the sheet needs name, ip and brand columns (as in the template), or a Bosch Project Assistant list.");
        }
        setSourceFormat(found.format);
        return takeRecords(found.records);
      } catch (err) {
        return setParseError((err as Error).message || "The file could not be read.");
      }
    }
    setSourceFormat("app");
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => h.trim().toLowerCase(),
      complete: (res) => {
        const headers = res.meta.fields ?? [];
        const missing = REQUIRED.filter((c) => !headers.includes(c));
        if (missing.length) {
          setParseError(`Missing required column(s): ${missing.join(", ")}. Use the template for the expected format.`);
          return;
        }
        if (res.data.length === 0) {
          setParseError("The file contains no camera rows.");
          return;
        }
        if (res.data.length > MAX_ROWS) {
          setParseError(`The file has ${res.data.length} rows; import at most ${MAX_ROWS} at a time.`);
          return;
        }
        // Row numbers match the spreadsheet: the header is row 1.
        setRows(res.data.map((r, i) => ({ row: i + 2, ...Object.fromEntries(COLUMNS.map((c) => [c, (r[c] ?? "").trim()])) })));
      },
      error: () => setParseError("The file could not be read as CSV."),
    });
  };

  const validate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ results: ImportValidation[] }>("/cameras/import/validate", { method: "POST", body: { rows, options: buildOptions(opts) } });
      setValidation(r.results);
      setStep("review");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    setConfirm(false);
    setStep("importing");
    setResults([]);
    setProgress(0);
    const validRows = new Set(validation?.filter((v) => v.status === "valid").map((v) => v.row));
    const toSend = rows.filter((r) => validRows.has(r.row));
    const skipped: ImportRowResult[] = (validation ?? [])
      .filter((v) => v.status !== "valid")
      .map((v) => ({ row: v.row, status: "skipped", message: v.errors.map((e) => `${e.field}: ${e.message}`).join("; ") }));
    const all: ImportRowResult[] = [...skipped];
    try {
      for (let i = 0; i < toSend.length; i += BATCH) {
        const batch = toSend.slice(i, i + BATCH);
        const r = await api<{ results: ImportRowResult[] }>("/cameras/import", { method: "POST", body: { rows: batch, options: buildOptions(opts) } });
        all.push(...r.results);
        setProgress(Math.min(toSend.length, i + batch.length) / Math.max(1, toSend.length));
        setResults([...all]);
      }
    } catch (e) {
      setError(e);
    }
    setResults(all.sort((a, b) => a.row - b.row));
    setProgress(1);
    // Drop all row data (and passwords) from memory now that processing is complete.
    setRows([]);
    setOpts((o) => ({ ...o, sharedPassword: "" }));
    setStep("done");
    invalidate();
  };

  const updateRow = (row: number, key: keyof ImportRow, value: string) => {
    setRows((rs) => rs.map((r) => (r.row === row ? { ...r, [key]: value } : r)));
  };

  const counts = {
    valid: validation?.filter((v) => v.status === "valid").length ?? 0,
    invalid: validation?.filter((v) => v.status === "invalid").length ?? 0,
    duplicate: validation?.filter((v) => v.status === "duplicate").length ?? 0,
  };

  return (
    <>
      <PageHeader title="Import cameras" description="Register many cameras at once from a CSV file." />
      <ol className="mb-5 flex flex-wrap gap-2 text-sm" aria-label="Import steps">
        {(["upload", "review", "importing", "done"] as Step[]).map((s, i) => (
          <li key={s} aria-current={step === s ? "step" : undefined} className={clsx("rounded-full border px-3 py-1", step === s ? "border-accent bg-accent-soft/60 font-medium" : "border-line text-ink-secondary")}>
            {i + 1}. {{ upload: "Upload & options", review: "Review", importing: "Import", done: "Summary" }[s]}
          </li>
        ))}
      </ol>

      {step === "upload" && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="1. Choose a file">
            <div className="space-y-4 p-4 text-sm">
              <p className="text-ink-secondary">
                Columns: <code className="text-xs">{COLUMNS.join(",")}</code>. Name, ip and brand are required; port and protocol default per brand
                (HTTP 80). Rows from multiple brands are allowed.
              </p>
              <p className="text-ink-secondary">
                Bosch Project Assistant lists can be imported as they are (the Excel template, or its &ldquo;Unicode Text&rdquo; export): name,
                comment (as location), IP address and type number (as model) are read, the brand is Bosch, and a service password, if filled in,
                is used with the camera&apos;s &ldquo;service&rdquo; user.
              </p>
              <a href="/api/cameras/import/template" className="inline-flex items-center gap-2 font-medium text-accent-ink hover:underline">
                <Download className="h-4 w-4" /> Download CSV template
              </a>
              <div>
                <label htmlFor="csv" className="mb-1 block font-medium">CSV, Excel (.xlsx) or tab-separated text file</label>
                <input
                  id="csv"
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv,.xlsx,.txt,.tsv"
                  onChange={onFile}
                  className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-raised file:px-3 file:py-1.5 file:text-ink"
                />
              </div>
              <p className="flex items-start gap-2 text-xs text-ink-secondary">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-good" aria-hidden />
                The file is read in your browser and is not uploaded or stored. Only the rows are sent to the server for validation and import, and
                passwords are encrypted as soon as each camera is saved.
              </p>
              {parseError && <ErrorMessage error={parseError} />}
              {rows.length > 0 && !parseError && (
                <p className="flex items-center gap-2">
                  <FileUp className="h-4 w-4 text-ink-muted" /> {fileName}: {rows.length} camera row{rows.length === 1 ? "" : "s"} read
                  {sourceFormat === "bosch" && " (Bosch Project Assistant list)"}
                </p>
              )}
            </div>
          </Card>
          <Card title="2. Options">
            <div className="space-y-4 p-4">
              <Checkbox
                label="Use shared credentials"
                description="For cameras that share a username and password, so you don't have to repeat them in the file."
                checked={opts.useShared}
                onChange={(e) => setOpts({ ...opts, useShared: e.target.checked })}
              />
              {opts.useShared && (
                <div className="grid gap-3 border-l-2 border-line pl-4 sm:grid-cols-2">
                  <Field label="Shared username">{(id) => <Input id={id} value={opts.sharedUsername} onChange={(e) => setOpts({ ...opts, sharedUsername: e.target.value })} autoComplete="off" />}</Field>
                  <Field label="Shared password">{(id) => <Input id={id} type="password" value={opts.sharedPassword} onChange={(e) => setOpts({ ...opts, sharedPassword: e.target.value })} autoComplete="new-password" />}</Field>
                  <Field label="Apply to" className="sm:col-span-2">
                    {(id) => (
                      <Select id={id} value={opts.sharedMode} onChange={(e) => setOpts({ ...opts, sharedMode: e.target.value as Options["sharedMode"] })}>
                        <option value="missing">Rows with no username and password</option>
                        <option value="all">All rows (override credentials in the file)</option>
                      </Select>
                    )}
                  </Field>
                </div>
              )}
              <Checkbox label="Enable monitoring for imported cameras" checked={opts.monitoringEnabled} onChange={(e) => setOpts({ ...opts, monitoringEnabled: e.target.checked })} />
              <Checkbox
                label="Test connectivity while importing"
                description="Each camera is contacted once, a few at a time. Only the listed cameras are contacted; no network scanning."
                checked={opts.testConnectivity}
                onChange={(e) => setOpts({ ...opts, testConnectivity: e.target.checked })}
              />
              {opts.testConnectivity && (
                <div className="grid gap-3 border-l-2 border-line pl-4">
                  <Field label="Cameras tested at the same time">
                    {(id) => (
                      <Select id={id} value={opts.testConcurrency} onChange={(e) => setOpts({ ...opts, testConcurrency: Number(e.target.value) })}>
                        {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Checkbox label="Skip cameras whose test fails" description="Otherwise they are saved so you can diagnose them later." checked={opts.skipFailedTests} onChange={(e) => setOpts({ ...opts, skipFailedTests: e.target.checked })} />
                </div>
              )}
              <ErrorMessage error={error} />
              <Button variant="primary" className="w-full" disabled={rows.length === 0 || !!parseError} loading={busy} onClick={validate}>
                Validate {rows.length > 0 ? `${rows.length} rows` : ""}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {step === "review" && validation && (
        <Card
          title="3. Review"
          actions={
            <>
              <span className="text-sm text-ink-secondary">
                {counts.valid} valid · {counts.invalid} invalid · {counts.duplicate} duplicate
              </span>
              <Button onClick={() => setStep("upload")}>Back</Button>
              <Button loading={busy} onClick={validate}>Re-validate</Button>
              <Button variant="primary" disabled={counts.valid === 0} onClick={() => (counts.valid < validation.length ? setConfirm(true) : void runImport())}>
                Import {counts.valid} camera{counts.valid === 1 ? "" : "s"}
              </Button>
            </>
          }
        >
          <ErrorMessage error={error} className="m-4" />
          {counts.invalid + counts.duplicate > 0 && (
            <p className="border-b border-line px-4 py-2 text-sm text-ink-secondary">Fix the highlighted rows below (or in your file and upload again), then re-validate.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Row</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  {EDITABLE.map((c) => <th key={c} scope="col" className="px-3 py-2 font-medium capitalize">{c}</th>)}
                  <th scope="col" className="px-3 py-2 font-medium">Problems</th>
                </tr>
              </thead>
              <tbody>
                {validation.map((v) => {
                  const row = rows.find((r) => r.row === v.row);
                  const bad = v.status !== "valid";
                  const errFields = new Set(v.errors.map((e) => e.field));
                  return (
                    <tr key={v.row} className={clsx("border-t border-line align-top", bad && "bg-bad/5")}>
                      <td className="tabular px-3 py-2">{v.row}</td>
                      <td className="px-3 py-2">
                        {bad ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium"><XCircle className="h-4 w-4 text-bad" aria-hidden />{v.status === "duplicate" ? "Duplicate" : "Invalid"}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium"><CheckCircle2 className="h-4 w-4 text-good" aria-hidden />Valid</span>
                        )}
                      </td>
                      {EDITABLE.map((c) => (
                        <td key={c} className="px-3 py-2">
                          {bad && row ? (
                            <Input
                              aria-label={`Row ${v.row} ${c}`}
                              type={c === "password" ? "password" : "text"}
                              value={(row[c] as string) ?? ""}
                              invalid={errFields.has(c)}
                              onChange={(e) => updateRow(v.row, c, e.target.value)}
                              className="min-w-[90px] px-2 py-1 text-xs"
                            />
                          ) : c === "password" ? (
                            <span className="text-ink-muted">{v.camera?.usesSharedCredentials ? "shared" : "••••"}</span>
                          ) : c === "username" ? (
                            <span>{v.camera?.username}{v.camera?.usesSharedCredentials ? " (shared)" : ""}</span>
                          ) : c === "ip" ? (
                            <span className="tabular">{v.camera?.host}</span>
                          ) : (
                            <span>{String(v.camera?.[c as "name" | "brand" | "port" | "protocol"] ?? "")}</span>
                          )}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-xs">
                        {v.errors.map((e, i) => (
                          <div key={i}><span className="font-medium">{e.field}:</span> {e.message}</div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {(step === "importing" || step === "done") && (
        <Card title={step === "importing" ? "Importing…" : "4. Summary"} actions={step === "done" && <Button onClick={reset}>Import another file</Button>}>
          <div className="space-y-4 p-4">
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-accent/15" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Import progress">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress * 100}%` }} />
              </div>
              <p className="mt-1 text-sm text-ink-secondary">{Math.round(progress * 100)}% complete</p>
            </div>
            <ErrorMessage error={error} />
            {step === "done" && (
              <p className="text-sm">
                <strong>{results.filter((r) => r.status === "imported").length}</strong> imported ·{" "}
                <strong>{results.filter((r) => r.status === "skipped").length}</strong> skipped ·{" "}
                <strong>{results.filter((r) => r.status === "failed").length}</strong> failed.{" "}
                <Link to="/cameras" className="font-medium text-accent-ink hover:underline">View cameras</Link>
              </p>
            )}
            {results.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-ink-secondary">
                    <tr>
                      <th scope="col" className="py-2 pr-3 font-medium">Row</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Result</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Details</th>
                      <th scope="col" className="py-2 font-medium">Connection test</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => (
                      <tr key={r.row} className="border-t border-line align-top">
                        <td className="tabular py-2 pr-3">{r.row}</td>
                        <td className="py-2 pr-3 capitalize">
                          {r.status === "imported" && r.cameraId ? <Link className="text-accent-ink hover:underline" to={`/cameras/${r.cameraId}`}>Imported</Link> : r.status}
                        </td>
                        <td className="py-2 pr-3 text-ink-secondary">{r.message}</td>
                        <td className="py-2 text-ink-secondary">{r.test ? `${r.test.ok ? "Passed" : "Failed"}: ${r.test.message}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirm}
        title="Import valid rows only?"
        confirmLabel={`Import ${counts.valid} camera${counts.valid === 1 ? "" : "s"}`}
        onConfirm={() => void runImport()}
        onCancel={() => setConfirm(false)}
      >
        <p>
          {counts.invalid + counts.duplicate} row(s) have problems and will be skipped. {counts.valid} valid row(s) will be imported.
        </p>
      </ConfirmDialog>
    </>
  );
}
