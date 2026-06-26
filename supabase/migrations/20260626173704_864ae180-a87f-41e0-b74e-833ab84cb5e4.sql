
-- Persistent memory / facts the bot remembers about each user
CREATE TABLE public.user_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  key text not null,
  value text not null,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_facts TO authenticated;
GRANT ALL ON public.user_facts TO service_role;
ALTER TABLE public.user_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own facts" ON public.user_facts FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER user_facts_touch BEFORE UPDATE ON public.user_facts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Audit log of every write action the agent performs (emails, calendar, contacts, facts)
CREATE TABLE public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  thread_id uuid,
  action text not null,
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'ok',
  created_at timestamptz not null default now()
);

GRANT SELECT, INSERT ON public.agent_actions TO authenticated;
GRANT ALL ON public.agent_actions TO service_role;
ALTER TABLE public.agent_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own actions" ON public.agent_actions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own actions" ON public.agent_actions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE INDEX agent_actions_user_created_idx ON public.agent_actions (user_id, created_at DESC);
