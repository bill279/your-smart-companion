
CREATE POLICY "users read own chat uploads"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'chat-uploads' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "users insert own chat uploads"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'chat-uploads' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "users delete own chat uploads"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'chat-uploads' AND auth.uid()::text = (storage.foldername(name))[1]);
