import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import bpaLogo from "@/assets/bpa-logo.png.asset.json";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Reset password — BPA Bot" }],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Supabase auto-exchanges the recovery token on this page load.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Password updated. Signing you in...");
      navigate({ to: "/chat" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="hud-panel hud-corner w-full max-w-md p-8 rounded-lg">
        <div className="text-center mb-8">
          <img src={bpaLogo.url} alt="BP Automation logo" className="mx-auto mb-4 h-16 w-auto" />
          <div className="text-3xl font-bold text-primary">Set new password</div>
        </div>

        {!ready ? (
          <p className="text-sm text-muted-foreground text-center">
            Verifying reset link... if nothing happens within a few seconds, request a new link from the sign-in page.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                minLength={6}
                placeholder="new password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
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
            <input
              type={showPassword ? "text" : "password"}
              required
              minLength={6}
              placeholder="confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full bg-input/50 border border-primary/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded bg-primary text-primary-foreground font-semibold tracking-wider hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "..." : "UPDATE PASSWORD"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}