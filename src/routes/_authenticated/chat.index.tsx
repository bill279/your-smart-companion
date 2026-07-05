import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createThread, listThreads } from "@/lib/jarvis.functions";

export const Route = createFileRoute("/_authenticated/chat/")({
  ssr: false,
  head: () => ({
    meta: [{ title: "BPA Bot" }],
  }),
  component: ChatHome,
});

function ChatHome() {
  const navigate = useNavigate();
  const list = useServerFn(listThreads);
  const create = useServerFn(createThread);
  const qc = useQueryClient();

  const threads = useQuery({ queryKey: ["threads"], queryFn: () => list({}) });

  const createMut = useMutation({
    mutationFn: async () => create({ data: {} }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      navigate({ to: "/chat/$threadId", params: { threadId: t.id } });
    },
  });

  useEffect(() => {
    if (!threads.data) return;
    if (threads.data.length > 0) {
      navigate({ to: "/chat/$threadId", params: { threadId: threads.data[0].id }, replace: true });
    } else if (!createMut.isPending && !createMut.isSuccess) {
      createMut.mutate();
    }
  }, [threads.data]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-primary tracking-[0.4em] hud-glow hud-pulse">INITIALIZING…</div>
    </div>
  );
}