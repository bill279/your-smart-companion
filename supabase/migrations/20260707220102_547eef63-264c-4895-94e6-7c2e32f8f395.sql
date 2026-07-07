
CREATE TABLE public.usage_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  kind TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.usage_events TO authenticated;
GRANT ALL ON public.usage_events TO service_role;

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own usage" ON public.usage_events
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users insert own usage" ON public.usage_events
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE INDEX usage_events_user_created_idx ON public.usage_events (user_id, created_at DESC);
CREATE INDEX usage_events_kind_idx ON public.usage_events (user_id, kind, created_at DESC);
