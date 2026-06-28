
CREATE OR REPLACE FUNCTION public.match_kb_chunks(
  query_embedding vector(1536),
  match_user_id uuid,
  match_count int DEFAULT 6
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  document_name text,
  content text,
  similarity float
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT c.id, c.document_id, d.name AS document_name, c.content,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.kb_chunks c
  JOIN public.kb_documents d ON d.id = c.document_id
  WHERE c.user_id = match_user_id
    AND c.user_id = auth.uid()
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE POLICY "Users read own kb files"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'kb-files' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users upload own kb files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'kb-files' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users delete own kb files"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'kb-files' AND auth.uid()::text = (storage.foldername(name))[1]);
