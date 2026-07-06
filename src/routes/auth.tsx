import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import bpaLogo from "@/assets/bpa-logo.png.asset.json";

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>) => ({
    next: typeof s.next === "string" && s.next.startsWith("/") && !s.next.startsWith("//") ? s.next : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in — BPA Bot" },
      { name: "description", content: "Authenticate to access your BPA Bot assistant." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const returnTo = next ?? "/chat";
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) window.location.href = returnTo;
    });
  }, [navigate, returnTo]);

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}${returnTo}` },
        });
        if (error) throw error;
        toast.success("Account created. You're in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      window.location.href = returnTo;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Auth failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="hud-panel hud-corner w-full max-w-md p-8 rounded-lg">
        <div className="text-center mb-8">
          <img
            src={bpaLogo.url}
            alt="BP Automation logo"
            className="mx-auto mb-4 h-16 w-auto"
          />
          <div className="text-3xl font-bold text-primary font-bold">BPA Bot</div>
          <div className="text-xs text-muted-foreground mt-2 tracking-widest">
            JUST A RATHER VERY INTELLIGENT SYSTEM
          </div>
        </div>

        <form onSubmit={handleEmail} className="space-y-3">
          <input
            type="email"
            required
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-input/50 border border-primary/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-input/50 border border-primary/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded bg-primary text-primary-foreground font-semibold tracking-wider hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "..." : mode === "signin" ? "ENGAGE" : "INITIALIZE"}
          </button>
        </form>

        <button
          onClick={() => setMode((m) => (m === "signin" ? "signup" : "signin"))}
          className="block mx-auto mt-4 text-xs text-muted-foreground hover:text-primary"
        >
          {mode === "signin" ? "Need an account? Create one" : "Have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}