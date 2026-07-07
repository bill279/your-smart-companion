
CREATE TABLE public.user_briefing_prefs (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'America/Edmonton',
  daily_enabled BOOLEAN NOT NULL DEFAULT true,
  daily_hour INT NOT NULL DEFAULT 7,
  weekly_enabled BOOLEAN NOT NULL DEFAULT true,
  weekly_dow INT NOT NULL DEFAULT 0,
  weekly_hour INT NOT NULL DEFAULT 18,
  briefing_thread_id UUID REFERENCES public.threads(id) ON DELETE SET NULL,
  last_daily_run_at TIMESTAMPTZ,
  last_weekly_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_briefing_prefs TO authenticated;
GRANT ALL ON public.user_briefing_prefs TO service_role;

ALTER TABLE public.user_briefing_prefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own briefing prefs"
  ON public.user_briefing_prefs
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_user_briefing_prefs_updated_at
  BEFORE UPDATE ON public.user_briefing_prefs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
