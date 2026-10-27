-- 恢复演练用的示例数据（scripts/restore-drill.sh）：覆盖每张业务表，id / 昵称与测试夹具不冲突。
-- 以超级用户执行（触发器照常运行：注册建资料、回复通知、审计）。
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  ('d0000000-0000-4000-a000-000000000001', 'drill-admin@example.com', '{"name":"演练管理员"}', now()),
  ('d0000000-0000-4000-a000-000000000002', 'drill-user@example.com', '{"name":"演练用户"}', now()),
  ('d0000000-0000-4000-a000-000000000003', 'drill-banned@example.com', '{"name":"演练封禁"}', now());
update public.profiles set role = 'admin' where id = 'd0000000-0000-4000-a000-000000000001';

insert into public.forum_threads (id, cat, title, body, author, pinned) values
  ('d1000000-0000-4000-b000-000000000001', '技术交流', '恢复演练主题', '正文 ![图](https://example.com/x.png)', 'd0000000-0000-4000-a000-000000000002', false),
  ('d1000000-0000-4000-b000-000000000002', '公告', '演练公告', '公告正文', 'd0000000-0000-4000-a000-000000000001', true);
insert into public.forum_replies (id, thread_id, body, author) values
  ('d2000000-0000-4000-b000-000000000001', 'd1000000-0000-4000-b000-000000000001', '演练回复 @演练用户', 'd0000000-0000-4000-a000-000000000001');
insert into public.comments (id, page_key, body, author) values
  ('d3000000-0000-4000-b000-000000000001', 'article:pinyin-initial-search', '演练评论', 'd0000000-0000-4000-a000-000000000002');
insert into public.likes (user_id, target_type, target_id) values
  ('d0000000-0000-4000-a000-000000000001', 'thread', 'd1000000-0000-4000-b000-000000000001');
insert into public.bookmarks (user_id, thread_key) values
  ('d0000000-0000-4000-a000-000000000002', 'd1000000-0000-4000-b000-000000000002');
insert into public.reports (reporter, target_type, target_id, reason, detail) values
  ('d0000000-0000-4000-a000-000000000002', 'reply', 'd2000000-0000-4000-b000-000000000001', 'spam', '演练举报');
insert into public.user_bans (user_id, reason, expires_at, created_by) values
  ('d0000000-0000-4000-a000-000000000003', '演练封禁', now() + interval '7 days', 'd0000000-0000-4000-a000-000000000001');
update public.profiles set banned = true where id = 'd0000000-0000-4000-a000-000000000003';
insert into public.site_content (kind, slug, data, published) values
  ('setting', 'announcement', '{"enabled":true,"text":"演练公告条","level":"info"}', true)
  on conflict (kind, slug) do nothing;
insert into public.rate_limit_events (user_id, action) values ('d0000000-0000-4000-a000-000000000002', 'thread');
insert into public.audit_log (actor, action, target_type, target_id) values
  ('d0000000-0000-4000-a000-000000000001', 'drill.seed', 'system', 'drill');
do $$ begin
  if to_regclass('storage.objects') is not null then
    insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values
      ('ugc-images', 'd0000000-0000-4000-a000-000000000002/202610-drill00-640x480.webp',
       'd0000000-0000-4000-a000-000000000002', 'd0000000-0000-4000-a000-000000000002',
       '{"size":1234,"mimetype":"image/webp"}');
  end if;
end $$;

-- 备份范围 auth.identities / private / storage.buckets 也要有数据，恢复后逐表核对才有意义
do $$ begin
  if to_regclass('auth.identities') is not null then
    insert into auth.identities (provider_id, user_id, identity_data, provider) values
      ('drill-gh-1', 'd0000000-0000-4000-a000-000000000002', '{"sub":"drill-gh-1"}', 'github'),
      ('d0000000-0000-4000-a000-000000000001', 'd0000000-0000-4000-a000-000000000001', '{"sub":"d0000000"}', 'email');
  end if;
  if to_regclass('private.community_submissions') is not null then
    insert into private.app_settings (key, value) values ('drill_secret', 'drill-only-not-a-real-secret')
      on conflict (key) do nothing;
  end if;
end $$;

