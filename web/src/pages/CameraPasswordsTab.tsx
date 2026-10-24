import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { CameraPasswordPolicy, CameraPasswordPolicyView } from "../api/types";
import { useToast } from "../components/toast";
import { Button, Card, Checkbox, ErrorMessage, Field, Input, Select, Spinner } from "../components/ui";
import { useAuth } from "../hooks/auth";

const STANDARD: CameraPasswordPolicy = { minLength: 8, minCharTypes: 3, blockCommon: true, maxAgeDays: 90, enforcement: "warn" };

/** Settings → Camera passwords: the standard for the cameras' own passwords, and how many meet it. */
export function CameraPasswordsTab() {
  const { can } = useAuth();
  const editable = can("settings:write");
  const toast = useToast();
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ["camera-password-policy"], queryFn: () => api<CameraPasswordPolicyView>("/settings/camera-password-policy") });
  const [draft, setDraft] = useState<CameraPasswordPolicy | null>(null);
  useEffect(() => {
    if (view.data && !draft) setDraft(view.data.policy);
  }, [view.data, draft]);
  const save = useMutation({
    mutationFn: (p: CameraPasswordPolicy) => api<CameraPasswordPolicyView>("/settings/camera-password-policy", { method: "PATCH", body: p }),
    onSuccess: (r) => {
      qc.setQueryData(["camera-password-policy"], r);
      void qc.invalidateQueries({ queryKey: ["cameras"] });
      setDraft(r.policy);
      toast("success", "Camera password policy saved; all cameras were checked again");
    },
    onError: (e: Error) => toast("error", e.message),
  });

  if (view.isLoading || !draft) return <Spinner />;
  if (view.error) return <ErrorMessage error={view.error} />;
  const counts = view.data!.counts;
  const set = <K extends keyof CameraPasswordPolicy>(k: K, v: CameraPasswordPolicy[K]) => setDraft({ ...draft, [k]: v });
  const num = (v: string) => (v === "" ? 0 : Number(v));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Count to="/cameras?password=ok" label="Meet the policy" value={counts.ok} />
        <Count to="/cameras?password=weak" label="Weak password" value={counts.weak} tone={counts.weak ? "bad" : undefined} />
        <Count to="/cameras?password=expired" label="Password change due" value={counts.expired} tone={counts.expired ? "warn" : undefined} />
      </div>

      <Card title="Policy">
        <form
          className="space-y-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(draft);
          }}
        >
          <p className="text-sm text-ink-secondary">
            The standard for the passwords the cameras themselves use, based on Hikvision and Dahua firmware rules, the IoT security
            standard ETSI EN 303 645 and NIST guidance. Change a password on the camera, then enter the new one in the app under Edit.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Minimum length" hint="Cameras accept 8 to 16 characters; 8 is the usual minimum, 12 is stronger.">
              {(id, d) => <Input id={id} aria-describedby={d} type="number" min={6} max={32} disabled={!editable} value={draft.minLength} onChange={(e) => set("minLength", num(e.target.value))} />}
            </Field>
            <Field label="Character types required" hint="Of uppercase, lowercase, numbers and symbols.">
              {(id, d) => (
                <Select id={id} aria-describedby={d} disabled={!editable} value={draft.minCharTypes} onChange={(e) => set("minCharTypes", Number(e.target.value))}>
                  <option value={1}>Any 1</option>
                  <option value={2}>At least 2</option>
                  <option value={3}>At least 3 (recommended)</option>
                  <option value={4}>All 4</option>
                </Select>
              )}
            </Field>
            <Field label="Change the password every (days)" hint="0 = never due. 90 days is the common standard.">
              {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} max={3650} disabled={!editable} value={draft.maxAgeDays} onChange={(e) => set("maxAgeDays", num(e.target.value))} />}
            </Field>
            <Field label="When a password does not meet the policy">
              {(id) => (
                <Select id={id} disabled={!editable} value={draft.enforcement} onChange={(e) => set("enforcement", e.target.value as CameraPasswordPolicy["enforcement"])}>
                  <option value="warn">Save it and flag the camera as weak</option>
                  <option value="block">Refuse to save it</option>
                </Select>
              )}
            </Field>
          </div>
          <Checkbox
            label="Refuse default and guessable passwords"
            description="Factory defaults and common passwords (12345, admin, 888888, password…), the username, and runs like 1111 or 12345."
            disabled={!editable}
            checked={draft.blockCommon}
            onChange={(e) => set("blockCommon", e.target.checked)}
          />
          {editable && (
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" onClick={() => setDraft(STANDARD)}>Use the standard policy</Button>
              <Button type="submit" variant="primary" loading={save.isPending}>Save policy</Button>
            </div>
          )}
        </form>
      </Card>
    </div>
  );
}

function Count({ to, label, value, tone }: { to: string; label: string; value: number; tone?: "bad" | "warn" }) {
  return (
    <Link to={to} className="rounded-lg border border-line bg-surface p-4 hover:border-accent">
      <div className={tone === "bad" ? "text-2xl font-semibold text-bad" : tone === "warn" ? "text-2xl font-semibold text-warn" : "text-2xl font-semibold"}>{value}</div>
      <div className="text-sm text-ink-secondary">{label} →</div>
    </Link>
  );
}
