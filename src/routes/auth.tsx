import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  ssr: false,
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
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/chat" });
    });
  }, [navigate]);

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/chat` },
        });
        if (error) throw error;
        toast.success("Account created. You're in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      navigate({ to: "/chat" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Auth failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setLoading(true);
    const res = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: `${window.location.origin}/chat`,
    });
    if (res.error) {
      toast.error(res.error.message);
      setLoading(false);
    } else if (!res.redirected) {
      navigate({ to: "/chat" });
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="hud-panel hud-corner w-full max-w-md p-8 rounded-lg">
        <div className="text-center mb-8">
          <div className="text-3xl font-bold text-primary font-bold">BPA Bot</div>
          <div className="text-xs text-muted-foreground mt-2 tracking-widest">
            JUST A RATHER VERY INTELLIGENT SYSTEM
          </div>
        </div>

        <button
          onClick={handleGoogle}
          disabled={loading}
          className="w-full mb-4 py-2.5 px-4 rounded border border-primary/40 hover:border-primary hover:bg-primary/10 transition text-sm tracking-wide disabled:opacity-50"
        >
          Continue with Google
        </button>

        <div className="flex items-center gap-3 my-4 text-xs text-muted-foreground">
          <div className="flex-1 h-px bg-primary/20" />
          <span>OR</span>
          <div className="flex-1 h-px bg-primary/20" />
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