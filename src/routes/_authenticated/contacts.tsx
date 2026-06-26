import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Plus, Trash2, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import {
  deleteContact,
  listContacts,
  upsertContact,
} from "@/lib/contacts.functions";

export const Route = createFileRoute("/_authenticated/contacts")({
  ssr: false,
  head: () => ({ meta: [{ title: "Contacts — BPA Bot" }] }),
  component: ContactsPage,
});

type Contact = {
  id: string;
  name: string;
  email: string;
  notes: string | null;
};

function ContactsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listContacts);
  const save = useServerFn(upsertContact);
  const del = useServerFn(deleteContact);

  const contactsQ = useQuery({ queryKey: ["contacts"], queryFn: () => list({}) });
  const [editing, setEditing] = useState<Partial<Contact> | null>(null);

  const saveMut = useMutation({
    mutationFn: (c: Partial<Contact>) =>
      save({ data: { id: c.id, name: c.name!, email: c.email!, notes: c.notes ?? null } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      setEditing(null);
      toast.success("Contact saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast.success("Contact deleted");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!editing?.name?.trim() || !editing?.email?.trim()) return;
    saveMut.mutate(editing);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-4 py-3 flex items-center gap-3 sticky top-0 bg-card/95 backdrop-blur z-10">
        <Link
          to="/chat"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
        >
          <ArrowLeft size={16} /> Back
        </Link>
        <h1 className="text-base font-semibold flex-1">Saved contacts</h1>
        <button
          onClick={() => setEditing({ name: "", email: "", notes: "" })}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
        >
          <Plus size={14} /> New
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        <p className="text-sm text-muted-foreground mb-4">
          BPA Bot uses these when you say things like "email Mike" — no need to dictate
          the address every time.
        </p>

        {contactsQ.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : contactsQ.data && contactsQ.data.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border bg-card">
            {contactsQ.data.map((c) => (
              <li key={c.id} className="flex items-start gap-3 p-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-sm text-muted-foreground truncate">{c.email}</div>
                  {c.notes && (
                    <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {c.notes}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setEditing(c)}
                  className="p-1.5 text-muted-foreground hover:text-foreground"
                  aria-label="Edit"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete ${c.name}?`)) delMut.mutate(c.id);
                  }}
                  className="p-1.5 text-muted-foreground hover:text-destructive"
                  aria-label="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-8 text-center">
            No contacts yet. Add one to get started.
          </div>
        )}
      </main>

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <form
            onSubmit={submit}
            className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{editing.id ? "Edit contact" : "New contact"}</h2>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Name</label>
              <input
                autoFocus
                value={editing.name ?? ""}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
                placeholder="Mike Johnson"
                required
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Email</label>
              <input
                type="email"
                value={editing.email ?? ""}
                onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
                placeholder="mike@example.com"
                required
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Notes (optional)</label>
              <textarea
                value={editing.notes ?? ""}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm min-h-[70px]"
                placeholder="Role, company, anything BPA Bot should know."
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="px-3 py-1.5 rounded-md border border-border text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saveMut.isPending}
                className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
              >
                {saveMut.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}