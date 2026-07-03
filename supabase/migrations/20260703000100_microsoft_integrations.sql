-- Direct Microsoft Graph integrations. Tokens are service-role only; the
-- browser and normal authenticated role should never be able to read them.

CREATE TABLE IF NOT EXISTS public.user_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  provider_account_email text,
  scopes text[] not null default '{}',
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

GRANT ALL ON public.user_integrations TO service_role;
REVOKE ALL ON public.user_integrations FROM anon;
REVOKE ALL ON public.user_integrations FROM authenticated;

ALTER TABLE public.user_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages integrations"
  ON public.user_integrations
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TRIGGER user_integrations_touch_updated_at
  BEFORE UPDATE ON public.user_integrations
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX IF NOT EXISTS user_integrations_user_provider_idx
  ON public.user_integrations (user_id, provider);
