
CREATE TABLE public.lessons_learned (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  lesson TEXT NOT NULL,
  context TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lessons_learned TO authenticated;
GRANT ALL ON public.lessons_learned TO service_role;
ALTER TABLE public.lessons_learned ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own lessons" ON public.lessons_learned FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX lessons_learned_user_recent ON public.lessons_learned (user_id, created_at DESC);

CREATE TABLE public.message_feedback (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  thread_id UUID,
  rating TEXT NOT NULL CHECK (rating IN ('up','down')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, message_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_feedback TO authenticated;
GRANT ALL ON public.message_feedback TO service_role;
ALTER TABLE public.message_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own feedback" ON public.message_feedback FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
