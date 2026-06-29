import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { toast } from "sonner";
import bpaLogo from "@/assets/bpa-logo.png.asset.json";

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
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/chat" });
    });
  }, [navigate]);

  function friendlyError(msg: string): string {
    const m = msg.toLowerCase();
    if (m.includes("invalid login")) return "Wrong email or password.";
    if (m.includes("email not confirmed")) return "Please confirm your email first. Check your inbox.";
    if (m.includes("already registered") || m.includes("user already")) return "An account with this email already exists. Try signing in.";
    if (m.includes("password should be")) return "Password must be at least 6 characters.";
    if (m.includes("rate limit")) return "Too many attempts. Please wait a moment and try again.";
    return msg;
  }

  async function resendConfirmation() {
    if (!email) {
      toast.error("Enter your email first");
      return;
    }
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${window.location.origin}/chat` },
    });
    if (error) toast.error(friendlyError(error.message));
    else toast.success("Confirmation email re-sent.");
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      toast.error("Enter your email");
      return;
    }
    setLoading(true);
    try {
      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        toast.success("Password reset link sent. Check your email.");
        setMode("signin");
        return;
      }
      if (mode === "signup") {
        if (password.length < 6) {
          toast.error("Password must be at least 6 characters.");
          return;
        }
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: `${window.location.origin}/chat` },
        });
        if (error) throw error;
        const { data: sess } = await supabase.auth.getSession();
        if (!sess.session) {
          toast.success("Account created. Check your email to confirm, then sign in.");
          setMode("signin");
          return;
        }
        toast.success("Account created. You're in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
      navigate({ to: "/chat" });
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Auth failed";
      const msg = friendlyError(raw);
      toast.error(msg);
      if (msg.includes("confirm your email")) {
        toast("Tap 'Resend confirmation' below to get a new link.", { duration: 4000 });
      }
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
            autoComplete="email"
            className="w-full bg-input/50 border border-primary/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary"
          />
          {mode !== "forgot" && (
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                minLength={6}
                placeholder="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                className="w-full bg-input/50 border border-primary/30 rounded px-3 py-2 pr-16 text-sm focus:outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-primary px-2 py-1"
                tabIndex={-1}
              >
                {showPassword ? "hide" : "show"}
              </button>
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded bg-primary text-primary-foreground font-semibold tracking-wider hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "..." : mode === "signin" ? "ENGAGE" : mode === "signup" ? "INITIALIZE" : "SEND RESET LINK"}
          </button>
        </form>

        <div className="mt-4 flex flex-col items-center gap-2 text-xs text-muted-foreground">
          {mode === "signin" && (
            <>
              <button onClick={() => setMode("forgot")} className="hover:text-primary">
                Forgot password?
              </button>
              <button onClick={() => setMode("signup")} className="hover:text-primary">
                Need an account? Create one
              </button>
              <button onClick={resendConfirmation} className="hover:text-primary">
                Resend confirmation email
              </button>
            </>
          )}
          {mode === "signup" && (
            <button onClick={() => setMode("signin")} className="hover:text-primary">
              Have an account? Sign in
            </button>
          )}
          {mode === "forgot" && (
            <button onClick={() => setMode("signin")} className="hover:text-primary">
              Back to sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}