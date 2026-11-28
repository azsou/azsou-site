-- SB05 private preview: CI-only hypothesis, never install this file on a hosted database.
-- No new buckets, objects, privileges, RPCs, writable policies or changes to UGC.
begin;
do $guard$
begin
  if current_database() !~ '^azsou_test_cmsmedia_[0-9]+$' then
    raise exception 'Requires the disposable cmsmedia test database';
  end if;
  if not exists (select 1 from pg_class where oid = 'storage.objects'::regclass and relrowsecurity)
     or not exists (
       select 1 from storage.buckets where id = 'az-cms-draft-media-sb05'
         and name = id and public is false and file_size_limit = 1048576
         and allowed_mime_types = array['image/png']::text[]
     ) then
    raise exception 'Private fixture bucket or row security missing';
  end if;
end;
$guard$;
create policy az_sb05_canary_preview_read on storage.objects
  for select to authenticated
  using (bucket_id = 'az-cms-draft-media-sb05'
         and name = 'sb05-check-864e09ae.png'
         and (select auth.uid()) is not null
         and (select public.is_admin()) is true
         and (select public.can_write()) is true);
commit;
