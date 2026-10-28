import { Wrench } from "lucide-react";
import { useState } from "react";
import { useSetMaintenance } from "../hooks/cameras";
import { Button, Dialog, Field, Input, Select } from "./ui";

const DURATIONS = [
  { minutes: 60, label: "1 hour" }, { minutes: 120, label: "2 hours" }, { minutes: 240, label: "4 hours" }, { minutes: 480, label: "8 hours" },
  { minutes: 1440, label: "1 day" }, { minutes: 4320, label: "3 days" }, { minutes: 10080, label: "1 week" }, { minutes: 43200, label: "30 days" },
];

/**
 * Puts cameras in maintenance for planned work: they are still checked and shown, but open no new
 * alerts and send no notifications until the time is up.
 */
export function MaintenanceDialog({ ids, open, onClose, onDone }: { ids: string[]; open: boolean; onClose: () => void; onDone?: () => void }) {
  const [minutes, setMinutes] = useState(240);
  const [note, setNote] = useState("");
  const set = useSetMaintenance();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={ids.length === 1 ? "Put the camera in maintenance" : `Put ${ids.length} cameras in maintenance`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" icon={<Wrench className="h-4 w-4" />} loading={set.isPending}
            onClick={() => set.mutate({ ids, minutes, note: note.trim() || undefined }, { onSuccess: () => { onClose(); onDone?.(); } })}
          >
            Start maintenance
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          For planned work or a camera being replaced. Meanwhile the camera is still checked and its status shown, but it opens no new alerts and
          sends no emails or chat messages; alerts already open stay as they are. Alerts resume by themselves when the time is up.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="For">
            {(id) => (
              <Select id={id} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {DURATIONS.map((d) => <option key={d.minutes} value={d.minutes}>{d.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Note (optional)" hint="e.g. Replacing the switch">
            {(id, d) => <Input id={id} aria-describedby={d} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
