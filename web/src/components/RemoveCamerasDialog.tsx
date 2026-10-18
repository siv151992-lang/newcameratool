import { ConfirmDialog } from "./ui";

/** Confirmation copy for removing cameras; shared by single and bulk removal. */
export function RemoveCamerasDialog({
  open,
  names,
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  names: string[];
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const plural = names.length !== 1;
  return (
    <ConfirmDialog
      open={open}
      danger
      loading={loading}
      title={plural ? `Remove ${names.length} cameras?` : `Remove ${names[0] ?? "camera"}?`}
      confirmLabel={plural ? `Remove ${names.length} cameras` : "Remove camera"}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>Removing stops all future storage checks and alerts for {plural ? "these cameras" : "this camera"}. Stored camera credentials are deleted.</p>
      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-ink-secondary">
        {names.slice(0, 10).map((n) => (
          <li key={n}>{n}</li>
        ))}
        {names.length > 10 && <li>…and {names.length - 10} more</li>}
      </ul>
      <p className="mt-3 text-ink-secondary">
        Monitoring history, alert history and audit records are kept. Nothing is changed on the physical camera. To pause monitoring
        temporarily instead, use <strong>Disable monitoring</strong>.
      </p>
    </ConfirmDialog>
  );
}
