import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import type { Organization } from "../api/types";
import { Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorMessage, Field, Input, Spinner } from "../components/ui";
import { useToast } from "../components/toast";
import { useAuth } from "../hooks/auth";
import { absoluteTime } from "../lib/format";

/**
 * Organizations, for the system administrator: create, rename, deactivate. Whoever creates an
 * organization becomes its first Org Admin and then adds its people.
 */
export function OrganizationsTab() {
  const { organizations: mine, switchOrganization, refresh: refreshMe } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ["organizations"], queryFn: () => api<Organization[]>("/organizations") });
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null);
  const [deactivating, setDeactivating] = useState<Organization | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["organizations"] });
    await refreshMe();
  };

  const save = useMutation({
    mutationFn: () =>
      editing!.id
        ? api(`/organizations/${editing!.id}`, { method: "PATCH", body: { name: editing!.name } })
        : api<{ id: string }>("/organizations", { method: "POST", body: { name: editing!.name } }),
    onSuccess: async () => {
      toast("success", editing!.id ? "Organization renamed" : `${editing!.name.trim()} created. You are its Org Admin.`);
      setEditing(null);
      await refresh();
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api(`/organizations/${id}`, { method: "PATCH", body: { isActive } }),
    onSuccess: async (_r, v) => {
      toast("success", v.isActive ? "Organization reactivated" : "Organization deactivated");
      setDeactivating(null);
      await refresh();
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-secondary">
        Each organization has its own cameras, alerts, notification channels, thresholds and audit log; its people see nothing of other
        organizations. You become the first Org Admin of an organization you create and can then add its people.
      </p>
      <Card title="Organizations" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ name: "" })}>New organization</Button>}>
        {orgs.isLoading ? (
          <Spinner />
        ) : orgs.error ? (
          <ErrorMessage error={orgs.error} className="m-4" />
        ) : !orgs.data?.length ? (
          <EmptyState icon={<Building2 className="h-6 w-6" />} title="No organizations yet" description="Create the first organization to start adding cameras." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-secondary">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Organization</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Members</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Org Admins</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Cameras</th>
                  <th scope="col" className="px-4 py-2 font-medium">Created</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orgs.data.map((o) => {
                  const member = mine.some((m) => m.id === o.id);
                  return (
                    <tr key={o.id} className="border-t border-line">
                      <td className="px-4 py-2">
                        <div className="font-medium">{o.name}</div>
                        {!o.isActive && <div className="text-xs text-ink-muted">Deactivated: nobody can open it and its cameras are not checked</div>}
                      </td>
                      <td className="tabular px-4 py-2 text-right">{o.members}</td>
                      <td className="tabular px-4 py-2 text-right">{o.admins}</td>
                      <td className="tabular px-4 py-2 text-right">{o.cameras}</td>
                      <td className="px-4 py-2 text-ink-secondary">{absoluteTime(o.createdAt)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right">
                        {member && o.isActive && (
                          <Button size="sm" variant="ghost" onClick={() => void switchOrganization(o.id).catch((e: Error) => toast("error", e.message))}>Open</Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ id: o.id, name: o.name })}>Rename</Button>
                        {o.isActive ? (
                          <Button size="sm" variant="ghost" onClick={() => setDeactivating(o)}>Deactivate</Button>
                        ) : (
                          <Button size="sm" variant="ghost" loading={setActive.isPending && setActive.variables?.id === o.id} onClick={() => setActive.mutate({ id: o.id, isActive: true })}>Reactivate</Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Rename organization" : "New organization"}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!editing?.name.trim()} onClick={() => save.mutate()}>{editing?.id ? "Save" : "Create"}</Button></>}
      >
        {editing && (
          <Field label="Name" required>
            {(id) => <Input id={id} value={editing.name} maxLength={120} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}
          </Field>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!deactivating}
        danger
        title={`Deactivate ${deactivating?.name}?`}
        confirmLabel="Deactivate"
        loading={setActive.isPending}
        onCancel={() => setDeactivating(null)}
        onConfirm={() => setActive.mutate({ id: deactivating!.id, isActive: false })}
      >
        <p>Its people lose access at once and its {deactivating?.cameras} camera(s) stop being checked. Nothing is deleted: you can reactivate it later.</p>
      </ConfirmDialog>
    </div>
  );
}
