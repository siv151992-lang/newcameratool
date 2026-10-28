import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CircleX, KeyRound, Search, Wand2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import type { IntegrationSummary } from "../../api/types";
import { useToast } from "../../components/toast";
import { Button, Card, ErrorMessage, Field, Input, Select } from "../../components/ui";

interface Attempt { key: string; displayName: string; result: "works" | "login_refused" | "no"; message: string; storageDevices?: number; model?: string | null }
interface Detection { reachable: boolean; match: Attempt | null; attempts: Attempt[] }

/**
 * Adding a brand the simple way: the brand's name and one of its cameras. The app tries its
 * built-in adapters on that camera (Hikvision, Dahua, … and ONVIF, the standard most cameras speak)
 * and saves the brand as working like the one that read the camera. Nothing about the camera is kept.
 */
export function QuickAddBrand() {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [cam, setCam] = useState({ host: "", port: "", protocol: "http" as "http" | "https", username: "admin", password: "" });
  const [found, setFound] = useState<Detection | null>(null);

  const detect = useMutation({
    mutationFn: () => api<Detection>("/integrations/detect", {
      method: "POST",
      body: { host: cam.host.trim(), protocol: cam.protocol, username: cam.username, password: cam.password, ...(cam.port ? { port: Number(cam.port) } : {}) },
    }),
    onMutate: () => setFound(null),
    onSuccess: setFound,
  });
  const save = useMutation({
    mutationFn: (basedOn: string) => api<IntegrationSummary>("/integrations/works-like", {
      method: "POST", body: { displayName: name.trim(), manufacturer: manufacturer.trim() || undefined, basedOn, defaultProtocol: cam.protocol },
    }),
    onSuccess: (b) => {
      toast("success", `${b.displayName} added: choose it as the brand when adding its cameras`);
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      void qc.invalidateQueries({ queryKey: ["brands"] });
      navigate(`/settings/brands/${b.key}`);
    },
    onError: (e: Error) => toast("error", e.message),
  });

  const canDetect = name.trim().length >= 2 && cam.host.trim() !== "";
  const match = found?.match;

  return (
    <div className="space-y-5">
      <div>
        <Link to="/settings/brands" className="text-sm text-ink-secondary hover:underline">← All camera brands</Link>
        <h2 className="mt-1 text-lg font-semibold">Add brand</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-secondary">
          Enter the brand&apos;s name and one of its cameras. The app tries the ways it already knows to talk to cameras (Hikvision, Dahua, Uniview,
          Hanwha, Axis, … and ONVIF, the standard most cameras support) and adds the brand working like the one that reads the camera. Many brands
          run another maker&apos;s firmware, so this is usually all it takes. The camera&apos;s address and password are only used for the test.
        </p>
      </div>

      <Card title="1. The brand">
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Brand name" required hint="As people know it, e.g. Prama, CP Plus, Godrej. Shown when adding a camera.">
            {(id, d) => <Input id={id} aria-describedby={d} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Manufacturer (optional)">
            {(id) => <Input id={id} value={manufacturer} maxLength={80} onChange={(e) => setManufacturer(e.target.value)} />}
          </Field>
        </div>
      </Card>

      <Card title="2. One of its cameras">
        <div className="grid gap-3 p-4 sm:grid-cols-6">
          <Field label="Camera address" required className="sm:col-span-2" hint="IP address or hostname">
            {(id, d) => <Input id={id} aria-describedby={d} value={cam.host} placeholder="192.168.1.64" onChange={(e) => setCam({ ...cam, host: e.target.value })} />}
          </Field>
          <Field label="Protocol">
            {(id) => (
              <Select id={id} value={cam.protocol} onChange={(e) => setCam({ ...cam, protocol: e.target.value as "http" | "https" })}>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </Select>
            )}
          </Field>
          <Field label="Port" hint="Blank: the usual one">
            {(id, d) => <Input id={id} aria-describedby={d} inputMode="numeric" value={cam.port} placeholder={cam.protocol === "https" ? "443" : "80"} onChange={(e) => setCam({ ...cam, port: e.target.value.replace(/\D/g, "").slice(0, 5) })} />}
          </Field>
          <Field label="User name">
            {(id) => <Input id={id} autoComplete="off" value={cam.username} onChange={(e) => setCam({ ...cam, username: e.target.value })} />}
          </Field>
          <Field label="Password">
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={cam.password} onChange={(e) => setCam({ ...cam, password: e.target.value })} />}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          <Button variant="primary" icon={<Search className="h-4 w-4" />} loading={detect.isPending} disabled={!canDetect} onClick={() => detect.mutate()}>
            {detect.isPending ? "Trying each way…" : "Detect"}
          </Button>
          <span className="text-xs text-ink-muted">Tries one way at a time, so it can take up to a minute.</span>
        </div>
      </Card>

      {detect.error && <ErrorMessage error={detect.error as Error} />}

      {found && (
        <Card title="3. Result">
          <div className="space-y-3 p-4">
            {!found.reachable ? (
              <p className="text-sm">
                <strong>The camera could not be reached:</strong> {found.attempts.at(-1)?.message}. Check the address and port, and that it is inside
                the allowed camera networks (Settings → Camera networks).
              </p>
            ) : match?.result === "works" ? (
              <div className="rounded-md border border-good/50 bg-good/10 p-3 text-sm">
                <p className="font-medium"><Check className="mr-1 inline h-4 w-4" aria-hidden />{name.trim()} cameras work like <strong>{match.displayName}</strong>.</p>
                <p className="mt-1 text-ink-secondary">
                  The app read the camera&apos;s storage ({match.storageDevices ?? 0} storage device{match.storageDevices === 1 ? "" : "s"}{match.model ? `, model ${match.model}` : ""}). Its cameras get
                  everything the {match.displayName} support has: monitoring, recordings, live view{match.key === "onvif" ? " (as far as the camera supports ONVIF)" : ""}.
                </p>
              </div>
            ) : match?.result === "login_refused" ? (
              <div className="rounded-md border border-warn/50 bg-warn/10 p-3 text-sm">
                <p className="font-medium"><KeyRound className="mr-1 inline h-4 w-4" aria-hidden />The camera answers like <strong>{match.displayName}</strong>, but refused the login.</p>
                <p className="mt-1 text-ink-secondary">Check the user name and password and press Detect again, or add the brand as working like {match.displayName} anyway.</p>
              </div>
            ) : (
              <div className="rounded-md border border-line bg-raised/50 p-3 text-sm">
                <p className="font-medium"><CircleX className="mr-1 inline h-4 w-4" aria-hidden />None of the known ways read this camera.</p>
                <p className="mt-1 text-ink-secondary">
                  Turn on ONVIF in the camera (and add an ONVIF user) and try again, or <Link to="manual" className="underline">set up its API by hand</Link>.
                </p>
              </div>
            )}

            {match && (
              <Button variant="primary" icon={<Wand2 className="h-4 w-4" />} loading={save.isPending} disabled={name.trim().length < 2} onClick={() => save.mutate(match.key)}>
                Add {name.trim() || "the brand"} (works like {match.displayName})
              </Button>
            )}

            <details className="text-xs text-ink-secondary">
              <summary className="cursor-pointer">What was tried</summary>
              <ul className="mt-2 space-y-1">
                {found.attempts.map((a) => (
                  <li key={a.key}>
                    <span className="font-medium">{a.displayName}</span>: {a.result === "works" ? "works" : a.result === "login_refused" ? "login refused" : a.message || "not this camera"}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </Card>
      )}

      <p className="text-sm text-ink-secondary">
        A brand with an API of its own that none of these speak? <Link to="manual" className="font-medium text-accent hover:underline">Set up its API by hand</Link> (for
        engineers: the request to send and where the storage figures are in the reply).
      </p>
    </div>
  );
}
