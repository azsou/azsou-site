-- =============================================================================
-- 0010_ugc_images.sql — 编辑器图片上传（P5）：Supabase Storage 公开读桶 `ugc-images` + 存储 RLS
--
--  * 桶：public = true（任何人可按公开 URL 读图），单文件 ≤ 2 MB，只收 image/jpeg、png、webp、gif
--    （大小与类型由 storage-api 按桶设置校验；下面的 RLS 在元数据存在时再校验一次）。
--  * 上传（INSERT）：已登录、未被封禁（can_write()）的用户，只能传到自己的 `<uid>/` 目录，
--    文件名只允许 `[a-z0-9-]{1,80}.(webp|png|jpg|jpeg|gif)`，并限流：10 分钟 10 张、24 小时 50 张
--    （版主 / 管理员不限流）。限流按库里已有对象计数，不需要往 Storage 表加触发器。
--  * 删除：本人删自己目录下的图；版主 / 管理员可删任何图（经 Storage API，Supabase 禁止直接 SQL 删除）。
--  * 不建 UPDATE 策略：上传不覆盖（客户端每次用新文件名，x-upsert: false）。
--  * Storage 不存在的库（纯 Postgres 且没跑带替身的 db/shim/plain.sql）：只创建 public 里的校验函数，
--    桶与策略跳过并给出 NOTICE，迁移照常完成。
--  * 纯增量，V72 不受影响；可重复执行。
-- =============================================================================

begin;

-- 上传校验（在 storage.objects 的 INSERT 策略里调用）。plpgsql 函数体在调用时才解析，
-- 所以没有 storage schema 的库也能创建它。
create or replace function public.az_ugc_image_upload_ok(p_name text, p_metadata jsonb default null)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  uid uuid := auth.uid();
  size bigint;
  mime text;
  recent integer;
  daily integer;
begin
  if uid is null or not public.can_write() then
    return false;
  end if;
  -- 路径：<自己的 uid>/<文件名>，不允许子目录
  if p_name is null
     or p_name !~ ('^' || uid::text || '/[a-z0-9][a-z0-9-]{0,79}\.(webp|png|jpg|jpeg|gif)$') then
    return false;
  end if;
  -- storage-api 收完文件后才写入元数据；有就再校验一次
  if p_metadata is not null then
    size := nullif(p_metadata->>'size', '')::bigint;
    mime := lower(coalesce(p_metadata->>'mimetype', p_metadata->>'contentType', ''));
    if size is not null and size > 2097152 then
      return false;
    end if;
    if mime <> '' and mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif') then
      return false;
    end if;
  end if;
  if public.is_moderator() then
    return true;
  end if;
  select count(*) filter (where o.created_at > now() - interval '10 minutes'), count(*)
    into recent, daily
    from storage.objects o
    where o.bucket_id = 'ugc-images'
      and o.name like uid::text || '/%'
      and o.created_at > now() - interval '24 hours';
  return recent < 10 and daily < 50;
end
$$;

-- 策略以调用者身份求值：authenticated 需要 EXECUTE（PostgREST 也会把它暴露成 RPC，只返回「我现在能不能传这个文件名」）
revoke execute on function public.az_ugc_image_upload_ok(text, jsonb) from public, anon;
grant execute on function public.az_ugc_image_upload_ok(text, jsonb) to authenticated, service_role;

do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice '0010: 没有 storage schema（非 Supabase 且未加载 Storage 替身），跳过 ugc-images 桶与存储策略';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('ugc-images', 'ugc-images', true, 2097152,
          array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists az_ugc_images_insert on storage.objects';
  execute $p$
    create policy az_ugc_images_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'ugc-images' and public.az_ugc_image_upload_ok(name, metadata))
  $p$;

  -- 公开桶的图片按公开 URL 读取，不经过 RLS；这条只让本人 / 版主能经 API 列出与管理
  execute 'drop policy if exists az_ugc_images_select on storage.objects';
  execute $p$
    create policy az_ugc_images_select on storage.objects for select to authenticated
      using (bucket_id = 'ugc-images'
             and (split_part(name, '/', 1) = (select auth.uid())::text or (select public.is_moderator())))
  $p$;

  execute 'drop policy if exists az_ugc_images_delete on storage.objects';
  execute $p$
    create policy az_ugc_images_delete on storage.objects for delete to authenticated
      using (bucket_id = 'ugc-images'
             and (split_part(name, '/', 1) = (select auth.uid())::text or (select public.is_moderator())))
  $p$;
end $$;

commit;
