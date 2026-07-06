import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { supabase } from "@/integrations/supabase/client";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Project-specific bearer attacher: like the generated one, but retries with
// refreshSession() when getSession() returns nothing. Voice callbacks (from
// the ElevenLabs SDK) can fire before Supabase has hydrated the session from
// storage, causing spurious 401s on addMessage.
const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    let token = (await supabase.auth.getSession()).data.session?.access_token;
    if (!token) {
      const { data } = await supabase.auth.refreshSession();
      token = data.session?.access_token;
    }
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [errorMiddleware],
}));
