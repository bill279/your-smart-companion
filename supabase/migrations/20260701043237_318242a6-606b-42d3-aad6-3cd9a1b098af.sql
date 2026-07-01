
CREATE TABLE public.assistant_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  interaction_mode TEXT NOT NULL DEFAULT 'text' CHECK (interaction_mode IN ('text','push_to_talk','continuous')),
  voice_provider TEXT NOT NULL DEFAULT 'elevenlabs' CHECK (voice_provider IN ('elevenlabs','openai_realtime','none')),
  model_provider TEXT NOT NULL DEFAULT 'openai' CHECK (model_provider IN ('openai')),
  cost_mode TEXT NOT NULL DEFAULT 'balanced' CHECK (cost_mode IN ('economy','balanced','premium')),
  max_voice_seconds INT NOT NULL DEFAULT 45 CHECK (max_voice_seconds BETWEEN 5 AND 300),
  require_approval BOOLEAN NOT NULL DEFAULT true,
  require_citations BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_settings TO authenticated;
GRANT ALL ON public.assistant_settings TO service_role;

ALTER TABLE public.assistant_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own assistant settings"
  ON public.assistant_settings FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER assistant_settings_touch_updated_at
  BEFORE UPDATE ON public.assistant_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
