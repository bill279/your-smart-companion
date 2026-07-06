
CREATE TABLE public.ms_oauth_tokens (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  ms_email TEXT,
  ms_user_id TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scope TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ms_oauth_tokens TO authenticated;
GRANT ALL ON public.ms_oauth_tokens TO service_role;

ALTER TABLE public.ms_oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own MS token"
  ON public.ms_oauth_tokens FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER ms_oauth_tokens_touch
  BEFORE UPDATE ON public.ms_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
