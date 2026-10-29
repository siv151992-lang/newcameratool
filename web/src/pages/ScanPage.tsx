import { useMutation, useQuery } from "@tanstack/react-query";
import { Radar, Upload } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Brand, ImportRow } from "../api/types";
import { Button, Card, EmptyState, ErrorMessage, Field, Input, PageHeader, Select } from "../components/ui";

interface FoundDevice {
  ip: string;
  openPorts: number[];
  brand: string | null;
  evidence: string[];
  port: number;
  protocol: "http" | "https";
  onvif: boolean;
  alreadyAdded: boolean;
}
interface ScanResult { range: string; scanned: number; skipped: number; devices: FoundDevice[]; durationMs: number }

/**
 * Finds cameras in an address range and hands the chosen ones to the import, where shared
 * credentials are entered, tested and the cameras added. The scan itself sends no credentials.
 */
export function ScanPage() {
  const navigate = useNavigate();
  const [range, setRange] = useState("");
  const [picked, setPicked] = useState<Record<string, { on: boolean; brand: string; name: string }>>({});
  const brands = useQuery({ queryKey: ["brands"], queryFn: () => api<Brand[]>("/brands"), staleTime: 300_000 });
  const scan = useMutation({
    mutationFn: () => api<ScanResult>("/cameras/scan", { method: "POST", body: { range: range.trim() } }),
    onSuccess: (r) =>
      setPicked(Object.fromEntries(r.devices.map((d) => [d.ip, { on: !d.alreadyAdded && d.brand !== null, brand: d.brand ?? "onvif", name: `Camera ${d.ip}` }]))),
  });
  const devices = scan.data?.devices ?? [];
  const chosen = devices.filter((d) => picked[d.ip]?.on);
  const label = (key: string | null) => brands.data?.find((b) => b.key === key)?.displayName ?? key ?? "Not recognised";

  const toImport = () => {
    // No passwords here: the import asks for the shared credentials, tests and adds the cameras.
    const rows: ImportRow[] = chosen.map((d, i) => ({
      row: i + 1, name: picked[d.ip]!.name, ip: d.ip, brand: picked[d.ip]!.brand, model: "", username: "", password: "", location: "",
      port: String(d.port), protocol: d.protocol,
    }));
    navigate("/cameras/import", { state: { scanRows: rows } });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Scan the network for cameras"
        description="Finds cameras in an address range, tells their brand where it can, and adds the ones you choose. Only addresses inside the allowed camera networks are scanned, and no passwords are sent."
        actions={<Button icon={<Upload className="h-4 w-4" />} onClick={() => navigate("/cameras/import")}>Import a file instead</Button>}
      />
      <Card title="1. Addresses to scan">
        <form className="flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); if (range.trim()) scan.mutate(); }}>
          <Field label="Address range" className="min-w-[16rem] flex-1" hint="A network (192.168.1.0/24), a range (192.168.1.10-60) or one address. At most 1024 addresses.">
            {(id, d) => <Input id={id} aria-describedby={d} value={range} placeholder="192.168.1.0/24" onChange={(e) => setRange(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" icon={<Radar className="h-4 w-4" />} loading={scan.isPending} disabled={!range.trim()}>
            {scan.isPending ? "Scanning…" : "Scan"}
          </Button>
          {scan.isPending && <span className="text-xs text-ink-muted">Up to about 30 seconds for a full network.</span>}
        </form>
      </Card>

      {scan.error && <ErrorMessage error={scan.error as Error} />}

      {scan.data && (
        <Card
          title={`2. Found ${devices.length} device${devices.length === 1 ? "" : "s"}`}
          actions={<span className="text-xs text-ink-muted">{scan.data.scanned} addresses scanned in {(scan.data.durationMs / 1000).toFixed(1)} s{scan.data.skipped ? ` · ${scan.data.skipped} outside the allowed camera networks skipped` : ""}</span>}
        >
          {devices.length === 0 ? (
            <EmptyState title="No devices answered" description="Nothing in this range accepted a connection on ports 80, 443, 554, 8000 or 37777. Check the range, and that this server can reach that network." />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line text-xs text-ink-secondary">
                    <tr>
                      <th scope="col" className="px-4 py-2"><span className="sr-only">Add</span></th>
                      <th scope="col" className="px-2 py-2 font-medium">Address</th>
                      <th scope="col" className="px-2 py-2 font-medium">Name</th>
                      <th scope="col" className="px-2 py-2 font-medium">Brand</th>
                      <th scope="col" className="px-2 py-2 font-medium">Found by</th>
                      <th scope="col" className="px-2 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => {
                      const p = picked[d.ip]!;
                      const set = (patch: Partial<typeof p>) => setPicked((all) => ({ ...all, [d.ip]: { ...all[d.ip]!, ...patch } }));
                      return (
                        <tr key={d.ip} className="border-b border-line last:border-0">
                          <td className="px-4 py-2">
                            <input type="checkbox" className="h-4 w-4" aria-label={`Add ${d.ip}`} checked={p.on} disabled={d.alreadyAdded} onChange={(e) => set({ on: e.target.checked })} />
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 tabular">{d.ip}<span className="block text-xs text-ink-muted">{d.protocol.toUpperCase()} port {d.port}</span></td>
                          <td className="px-2 py-2"><Input aria-label={`Name for ${d.ip}`} value={p.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} disabled={d.alreadyAdded} /></td>
                          <td className="px-2 py-2">
                            <Select aria-label={`Brand of ${d.ip}`} value={p.brand} onChange={(e) => set({ brand: e.target.value })} disabled={d.alreadyAdded}>
                              {(brands.data ?? []).map((b) => <option key={b.key} value={b.key}>{b.displayName}</option>)}
                            </Select>
                            {!d.brand && <span className="mt-0.5 block text-xs text-ink-muted">Not recognised: choose it</span>}
                          </td>
                          <td className="px-2 py-2 text-xs text-ink-secondary">{d.evidence.length ? d.evidence.join(" · ") : `Ports ${d.openPorts.join(", ")} open`}</td>
                          <td className="px-2 py-2 text-xs">{d.alreadyAdded ? <span className="text-ink-muted">Already added</span> : d.brand ? <span className="text-good">{label(d.brand)}</span> : <span className="text-warn">Unknown device</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
                <Button variant="primary" disabled={!chosen.length} onClick={toImport}>Continue with {chosen.length} camera{chosen.length === 1 ? "" : "s"}</Button>
                <span className="text-xs text-ink-muted">Next: enter the cameras' user name and password once, test them, and add them (on the <Link to="/cameras/import" className="underline">import</Link> page).</span>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
