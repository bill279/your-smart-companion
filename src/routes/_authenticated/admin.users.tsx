import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { listAllUsers, deleteUserById } from "@/lib/admin-users.functions";

export const Route = createFileRoute("/_authenticated/admin/users")({
  ssr: false,
  head: () => ({ meta: [{ title: "Admin — Users" }] }),
  component: AdminUsersPage,
});

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

function AdminUsersPage() {
  const load = useServerFn(listAllUsers);
  const del = useServerFn(deleteUserById);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-users"], queryFn: () => load({}) });
  const mut = useMutation({
    mutationFn: (userId: string) => del({ data: { userId } }),
    onSuccess: () => {
      toast.success("User deleted");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e: Error) => toast.error(e.message || "Failed to delete user"),
  });

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <Link to="/chat" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">Manage accounts. Deleting removes the user permanently.</p>
        </div>

        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

        {q.data && (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Last sign-in</th>
                  <th className="px-3 py-2 font-medium">Confirmed</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {q.data
                  .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
                  .map((u) => (
                    <tr key={u.id} className="border-t border-border">
                      <td className="px-3 py-2">{u.email}</td>
                      <td className="px-3 py-2 text-muted-foreground">{fmtDate(u.created_at)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{fmtDate(u.last_sign_in_at)}</td>
                      <td className="px-3 py-2">{u.email_confirmed_at ? "✅" : "❌"}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => {
                            if (confirm(`Delete ${u.email}? This cannot be undone.`)) mut.mutate(u.id);
                          }}
                          disabled={mut.isPending}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        >
                          <Trash2 className="w-4 h-4" /> Delete
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
