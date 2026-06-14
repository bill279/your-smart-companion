import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "JARVIS — Personal AI Assistant" },
      { name: "description", content: "Your Iron Man–style voice-first personal assistant." },
      { property: "og:title", content: "JARVIS — Personal AI Assistant" },
      { property: "og:description", content: "Voice-first personal assistant with web, email, and calendar tools." },
    ],
  }),
  beforeLoad: () => {
    throw redirect({ to: "/chat" });
  },
  component: () => null,
});
