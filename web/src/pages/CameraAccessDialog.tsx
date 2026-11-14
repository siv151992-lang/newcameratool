import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { Camera, ManagedUser, Page } from "../api/types";
import { Button, Checkbox, Dialog, ErrorMessage, Input, Spinner } from "../components/ui";
import { useToast } from "../components/toast";
import { ROLE_LABELS } from "../hooks/auth";

interface CameraAccess {
  mode: "all" | "limited";
  locations: string[];
  cameraIds: string[];
  role: string;
}

/** "All cameras", or what a limited member sees, for the Users list. */
export function cameraAccessLabel(u: ManagedUser): string {
  if (u.role === "admin") return "All cameras (Org Admin)";
  if (u.cameraAccess !== "limited") return "All cameras";
  const parts = [
    u.accessLocations && `${u.accessLocations} location${u.accessLocations === 1 ? "" : "s"}`,
    u.accessCameras && `${u.accessCameras} camera${u.accessCameras === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return `Only ${parts.join(" + ") || "chosen cameras"}`;
}

/**
 * Which cameras a member may see: every camera, or only chosen locations (sites: cameras added
 * there later are included) and chosen cameras. Applies to Operators and Viewers.
 */
export function CameraAccessDialog({ user, onClose }: { user: ManagedUser | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const open = !!user;
  const access = useQuery({
    queryKey: ["users", user?.id, "camera-access"],
    queryFn: () => api<CameraAccess>(`/users/${user!.id}/camera-access`),
    enabled: open,
  });
  const locations = useQuery({ queryKey: ["cameras", "locations"], queryFn: () => api<string[]>("/cameras/locations"), enabled: open });
  const [mode, setMode] = useState<"all" | "limited">("all");
  const [chosenLocations, setChosenLocations] = useState<string[]>([]);
  const [chosenCameras, setChosenCameras] = useState<string[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!access.data) return;
    setMode(access.data.mode);
    setChosenLocations(access.data.locations);
    setChosenCameras(access.data.cameraIds);
  }, [access.data]);
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const cameras = useQuery({
    queryKey: ["cameras", "access-picker", search],
    queryFn: () => api<Page<Camera>>(`/cameras?pageSize=50&sort=name${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ""}`),
    enabled: open && mode === "limited",
  });
  // Remember names of cameras seen, to show the chosen ones.
  useEffect(() => {
    if (!cameras.data) return;
    setNames((m) => {
      const next = new Map(m);
      for (const c of cameras.data.items) next.set(c.id, `${c.name} (${c.host})`);
      return next;
    });
  }, [cameras.data]);
  // Names of chosen cameras not in the first page of results.
  const unnamed = useMemo(() => chosenCameras.filter((id) => !names.has(id)), [chosenCameras, names]);

  const save = useMutation({
    mutationFn: () =>
      api<CameraAccess>(`/users/${user!.id}/camera-access`, {
        method: "PUT",
        body: mode === "all" ? { mode } : { mode, locations: chosenLocations, cameraIds: chosenCameras },
      }),
    onSuccess: () => {
      toast("success", mode === "all" ? `${user!.username} sees all cameras` : `${user!.username} sees only the chosen locations and cameras`);
      void qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (e: Error) => toast("error", e.message),
  });

  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const nothingChosen = mode === "limited" && !chosenLocations.length && !chosenCameras.length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Cameras ${user?.username ?? ""} can see`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!access.data || nothingChosen} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      {access.isLoading ? (
        <Spinner />
      ) : access.error ? (
        <ErrorMessage error={access.error} />
      ) : (
        <div className="space-y-4 text-sm">
          {user?.role === "admin" && (
            <p className="rounded-md border border-line bg-raised px-3 py-2 text-ink-secondary">
              {ROLE_LABELS.admin}s always see every camera. What is chosen here applies if their role is changed to {ROLE_LABELS.operator} or {ROLE_LABELS.viewer}.
            </p>
          )}
          <div className="space-y-2">
            <label className="flex items-start gap-2">
              <input type="radio" name="camera-access" className="mt-1" checked={mode === "all"} onChange={() => setMode("all")} />
              <span><span className="font-medium">All cameras</span><span className="block text-ink-secondary">Every camera of the organization, including ones added later.</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="camera-access" className="mt-1" checked={mode === "limited"} onChange={() => setMode("limited")} />
              <span>
                <span className="font-medium">Only the locations and cameras chosen below</span>
                <span className="block text-ink-secondary">Everything else is hidden from them: cameras, alerts, live view, recordings, reports and AI Mode.</span>
              </span>
            </label>
          </div>

          {mode === "limited" && (
            <>
              <section>
                <h3 className="mb-1 font-medium">Locations</h3>
                <p className="mb-2 text-xs text-ink-muted">Every camera at a chosen location, including cameras added there later.</p>
                {locations.data?.length ? (
                  <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto rounded-md border border-line p-2 sm:grid-cols-2">
                    {locations.data.map((l) => (
                      <Checkbox key={l} label={l} checked={chosenLocations.includes(l)} onChange={() => toggle(chosenLocations, setChosenLocations, l)} />
                    ))}
                  </div>
                ) : (
                  <p className="text-ink-secondary">No camera has a location yet (set it under Edit on a camera).</p>
                )}
              </section>

              <section>
                <h3 className="mb-1 font-medium">Cameras</h3>
                <p className="mb-2 text-xs text-ink-muted">Single cameras, in addition to the locations.</p>
                {chosenCameras.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {chosenCameras.filter((id) => names.has(id)).map((id) => (
                      <span key={id} className="inline-flex items-center gap-1 rounded-full border border-line bg-raised px-2 py-0.5 text-xs">
                        {names.get(id)}
                        <button type="button" aria-label={`Remove ${names.get(id)}`} onClick={() => toggle(chosenCameras, setChosenCameras, id)}><X className="h-3 w-3" /></button>
                      </span>
                    ))}
                    {unnamed.length > 0 && <span className="px-1 text-xs text-ink-muted">and {unnamed.length} more (search to see them)</span>}
                  </div>
                )}
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-ink-muted" />
                  <Input aria-label="Search cameras" className="pl-8" placeholder="Search name, IP, location…" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div className="max-h-56 overflow-y-auto rounded-md border border-line p-2">
                  {cameras.isLoading ? (
                    <Spinner />
                  ) : (
                    cameras.data?.items.map((c) => (
                      <Checkbox
                        key={c.id}
                        label={<>{c.name} <span className="text-ink-muted">{c.host}{c.location ? ` · ${c.location}` : ""}</span></>}
                        checked={chosenCameras.includes(c.id) || (!!c.location && chosenLocations.includes(c.location))}
                        disabled={!!c.location && chosenLocations.includes(c.location)}
                        onChange={() => toggle(chosenCameras, setChosenCameras, c.id)}
                      />
                    ))
                  )}
                  {cameras.data && cameras.data.total > cameras.data.items.length && (
                    <p className="mt-1 text-xs text-ink-muted">{cameras.data.total - cameras.data.items.length} more: search to find them.</p>
                  )}
                </div>
              </section>
              {nothingChosen && <p className="text-warn">Choose at least one location or camera.</p>}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
