import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CameraDetail, ConnectionResult, HistoryCheck } from "../api/types";
import { useToast } from "../components/toast";

/** Invalidates everything derived from camera state. */
export function useInvalidateCameras() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["cameras"] });
    void qc.invalidateQueries({ queryKey: ["camera"] });
    void qc.invalidateQueries({ queryKey: ["summary"] });
    void qc.invalidateQueries({ queryKey: ["alerts"] });
  };
}

export function useCheckNow() {
  const invalidate = useInvalidateCameras();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ outcome: { result?: { ok: boolean; errorMessage?: string } }; camera: CameraDetail }>(`/cameras/${id}/check-storage`, { method: "POST" }),
    onSuccess: (r) => {
      const res = r.outcome.result;
      if (res?.ok) toast("success", `${r.camera.name}: storage checked`);
      else toast("error", `${r.camera.name}: ${res?.errorMessage ?? "check failed"}`);
      invalidate();
    },
    onError: (e: Error) => toast("error", e.message),
  });
}

export function useSetMonitoring() {
  const invalidate = useInvalidateCameras();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<CameraDetail>(`/cameras/${id}/monitoring`, { method: "POST", body: { enabled } }),
    onSuccess: (c) => {
      toast("success", `Monitoring ${c.monitoringEnabled ? "enabled" : "paused"} for ${c.name}`);
      invalidate();
    },
    onError: (e: Error) => toast("error", e.message),
  });
}

/** The server accepts at most this many cameras per bulk request. */
const BULK_BATCH = 500;
const batches = (ids: string[]) => Array.from({ length: Math.ceil(ids.length / BULK_BATCH) }, (_, i) => ids.slice(i * BULK_BATCH, (i + 1) * BULK_BATCH));

export function useSetLocalStorage() {
  const invalidate = useInvalidateCameras();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ ids, localStorage }: { ids: string[]; localStorage: boolean }) => {
      let updated = 0;
      for (const chunk of batches(ids)) updated += (await api<{ updated: number }>("/cameras/bulk-local-storage", { method: "POST", body: { ids: chunk, localStorage } })).updated;
      return { updated };
    },
    onSuccess: (r, v) => {
      toast("success", `${r.updated} camera(s) marked as ${v.localStorage ? "using local storage" : "recording elsewhere (no local storage)"}`);
      invalidate();
    },
    onError: (e: Error) => toast("error", e.message),
  });
}

export function useRemoveCameras() {
  const invalidate = useInvalidateCameras();
  const toast = useToast();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const removed: string[] = [];
      for (const chunk of batches(ids)) removed.push(...(await api<{ removed: string[] }>("/cameras/bulk-delete", { method: "POST", body: { ids: chunk } })).removed);
      return { removed };
    },
    onSuccess: (r) => {
      toast("success", `Removed ${r.removed.length} camera${r.removed.length === 1 ? "" : "s"} from monitoring`);
      invalidate();
    },
    onError: (e: Error) => toast("error", e.message),
  });
}

export function useTestSavedCamera() {
  return useMutation({
    mutationFn: ({ id, overrides }: { id: string; overrides?: Record<string, unknown> }) =>
      api<ConnectionResult>(`/cameras/${id}/test-connection`, { method: "POST", body: overrides ?? {} }),
  });
}

export type { HistoryCheck };
