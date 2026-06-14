import { z } from "zod";

export function checkSecret(request: Request): Response | null {
  const expected = process.env.JARVIS_TOOL_SECRET;
  if (!expected) return new Response("Server missing JARVIS_TOOL_SECRET", { status: 500 });
  const provided = request.headers.get("x-jarvis-secret");
  if (provided !== expected) return new Response("Unauthorized", { status: 401 });
  return null;
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const body = await request.json().catch(() => ({}));
  return schema.parse(body);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function gatewayHeaders(connectorKeyEnv: string): HeadersInit {
  const lovable = process.env.LOVABLE_API_KEY;
  const conn = process.env[connectorKeyEnv];
  if (!lovable) throw new Error("LOVABLE_API_KEY missing");
  if (!conn) throw new Error(`${connectorKeyEnv} missing`);
  return {
    Authorization: `Bearer ${lovable}`,
    "X-Connection-Api-Key": conn,
    "Content-Type": "application/json",
  };
}