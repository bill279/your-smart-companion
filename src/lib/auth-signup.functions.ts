import { createServerFn } from "@tanstack/react-start";

const ALLOWED_DOMAINS = ["bpautomation.com", "bilmedia.com", "adstractdigital.com"];

export const signUpWithAllowedDomain = createServerFn({ method: "POST" })
  .inputValidator((input: { email: string; password: string }) => {
    if (!input?.email || !input?.password) throw new Error("Email and password required");
    if (input.password.length < 6) throw new Error("Password must be at least 6 characters");
    return input;
  })
  .handler(async ({ data }) => {
    const email = data.email.trim().toLowerCase();
    const domain = email.split("@")[1] ?? "";
    if (!ALLOWED_DOMAINS.includes(domain)) {
      throw new Error(
        `Sign-ups are restricted. Allowed email domains: ${ALLOWED_DOMAINS.join(", ")}`,
      );
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: data.password,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });