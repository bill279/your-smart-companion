import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Upload, Trash2, FileText, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  createKbUploadUrl,
  deleteKbDocument,
  ingestKbDocument,
  listKbDocuments,
} from "@/lib/knowledge.functions";

export const Route = createFileRoute("/_authenticated/knowledge")({
  ssr: false,
  head: () => ({ meta: [{ title: "Knowledge base — BPA Bot" }] }),
  component: KnowledgePage,
});

const ACCEPT = ".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv";
const MAX_BYTES = 20 * 1024 * 1024;

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function KnowledgePage() {
  const qc = useQueryClient();
  const list = useServerFn(listKbDocuments);
  const createUrl = useServerFn(createKbUploadUrl);
  const ingest = useServerFn(ingestKbDocument);
  const del = useServerFn(deleteKbDocument);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const docsQ = useQuery({
    queryKey: ["kb-docs"],
    queryFn: () => list({}),
    refetchInterval: (q) => {
      const data = q.state.data as Array<{ status: string }> | undefined;
      return data?.some((d) => d.status === "processing" || d.status === "pending") ? 2000 : false;
    },
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb-docs"] });
      toast.success("Document removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name}: file too large (max 20 MB)`);
        continue;
      }
      setUploading(file.name);
      try {
        const { path, token } = await createUrl({
          data: { name: file.name, mimeType: file.type || "application/octet-stream", size: file.size },
        });
        const up = await supabase.storage
          .from("kb-files")
          .uploadToSignedUrl(path, token, file, { contentType: file.type || undefined });
        if (up.error) throw new Error(up.error.message);
        qc.invalidateQueries({ queryKey: ["kb-docs"] });
        // Kick off ingestion (returns when done; UI shows status meanwhile)
        ingest({
          data: {
            path,
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
          },
        })
          .then(() => {
            qc.invalidateQueries({ queryKey: ["kb-docs"] });
            toast.success(`Indexed ${file.name}`);
          })
          .catch((e: Error) => {
            qc.invalidateQueries({ queryKey: ["kb-docs"] });
            toast.error(`${file.name}: ${e.message}`);
          });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(null);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-4 py-3 flex items-center gap-3 sticky top-0 bg-card/95 backdrop-blur z-10">
        <Link to="/chat" className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm">
          <ArrowLeft size={16} /> Back
        </Link>
        <h1 className="text-base font-semibold flex-1">Knowledge base</h1>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          <Upload size={14} /> {uploading ? "Uploading…" : "Upload"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        <p className="text-sm text-muted-foreground mb-4">
          Upload PDFs, text, Markdown, or CSV files (max 20 MB each). BPA Bot will automatically
          search them when you ask company-specific questions.
        </p>

        {docsQ.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : docsQ.data && docsQ.data.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border bg-card">
            {docsQ.data.map((d) => (
              <li key={d.id} className="flex items-start gap-3 p-3">
                <FileText size={18} className="text-muted-foreground mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{d.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>{formatSize(d.size_bytes)}</span>
                    <span>•</span>
                    {d.status === "ready" && (
                      <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 size={12} /> {d.chunk_count} chunks indexed
                      </span>
                    )}
                    {(d.status === "processing" || d.status === "pending") && (
                      <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                        <Loader2 size={12} className="animate-spin" /> Processing…
                      </span>
                    )}
                    {d.status === "error" && (
                      <span className="text-destructive flex items-center gap-1" title={d.error ?? ""}>
                        <AlertCircle size={12} /> Error: {d.error?.slice(0, 80) ?? "failed"}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (confirm(`Delete ${d.name}?`)) delMut.mutate(d.id);
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
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full text-sm text-muted-foreground border border-dashed border-border rounded-md p-10 text-center hover:bg-secondary/30"
          >
            <Upload size={20} className="mx-auto mb-2 opacity-60" />
            No documents yet. Click to upload your first file.
          </button>
        )}
      </main>
    </div>
  );
}