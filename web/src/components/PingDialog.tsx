import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Radar } from "lucide-react";
import { useEffect } from "react";
import { api } from "../api/client";
import { Button, Dialog, ErrorMessage, Spinner } from "./ui";

type Times = (number | null)[];
interface PingResult {
  host: string;
  address: string;
  icmp: { times: Times } | { unavailable: string };
  ports: { port: number; label: string; times: Times; error?: string }[];
  reachable: boolean;
  portOpen: boolean;
}

/** Pings a camera from the server: ICMP where allowed, and its web and RTSP ports, four times each. */
export function PingDialog({ camera, onClose }: { camera: { id: string; name: string } | null; onClose: () => void }) {
  const ping = useMutation({ mutationFn: (id: string) => api<PingResult>(`/cameras/${id}/ping`, { method: "POST" }) });
  const { mutate, reset } = ping;
  useEffect(() => {
    if (camera) mutate(camera.id);
    else reset();
  }, [camera, mutate, reset]);
  const r = ping.data;

  return (
    <Dialog
      open={camera !== null}
      onClose={onClose}
      title={camera ? `Ping ${camera.name}` : "Ping"}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<Radar className="h-4 w-4" />} loading={ping.isPending} onClick={() => camera && ping.mutate(camera.id)}>
            Ping again
          </Button>
        </>
      }
    >
      {ping.isPending && !r && <Spinner label="Pinging (up to 10 seconds)…" />}
      {ping.error && <ErrorMessage error={ping.error} />}
      {r && (
        <div className={clsx("space-y-3", ping.isPending && "opacity-60")}>
          <p className={clsx("rounded-md border p-2 font-medium", r.portOpen ? "border-good/50 bg-good/10" : r.reachable ? "border-warn/50 bg-warn/10" : "border-bad/50 bg-bad/10")}>
            {r.portOpen ? "The camera answers" : r.reachable ? "The address answers, but the camera's ports are closed" : "No answer from the camera"} · {r.host}
            {r.address !== r.host && <span className="font-normal text-ink-secondary"> ({r.address})</span>}
          </p>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-secondary">
              <tr>
                <th scope="col" className="py-1 font-medium">Test</th>
                <th scope="col" className="py-1 font-medium">Replies</th>
                <th scope="col" className="py-1 text-right font-medium">Time (min / avg / max)</th>
              </tr>
            </thead>
            <tbody>
              <Row label="ICMP ping" times={"times" in r.icmp ? r.icmp.times : null} note={"unavailable" in r.icmp ? r.icmp.unavailable : undefined} />
              {r.ports.map((p) => (
                <Row key={p.port} label={`${p.label} port ${p.port}`} times={p.times} note={p.error} />
              ))}
            </tbody>
          </table>
          <p className="text-xs text-ink-muted">
            Sent from the dashboard server, not your computer. Many cameras and networks drop ICMP ping; the ports show whether the camera itself
            answers. A refused connection means something is at the address, but not listening on that port (check the port, or that it is the right device).
          </p>
        </div>
      )}
    </Dialog>
  );
}

function Row({ label, times, note }: { label: string; times: Times | null; note?: string }) {
  const got = (times ?? []).filter((t): t is number => t !== null);
  const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : Math.round(ms).toString());
  return (
    <tr className="border-t border-line align-top">
      <td className="py-1.5 pr-2">{label}</td>
      <td className="py-1.5 pr-2">
        {times === null ? (
          <span className="text-ink-muted">Not available</span>
        ) : (
          <span className={clsx("font-medium", got.length === times.length ? "text-good" : got.length ? "text-warn" : "text-bad")}>
            {got.length} of {times.length}
          </span>
        )}
        {note && <span className="block text-xs text-ink-secondary">{note}</span>}
      </td>
      <td className="tabular py-1.5 text-right">
        {got.length ? `${fmt(Math.min(...got))} / ${fmt(got.reduce((a, b) => a + b, 0) / got.length)} / ${fmt(Math.max(...got))} ms` : "—"}
      </td>
    </tr>
  );
}
