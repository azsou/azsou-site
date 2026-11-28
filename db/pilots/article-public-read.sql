-- SB10-A2 CI-only public article reader pilot.
-- Never install on a hosted database or production. This file only targets the
-- disposable article-release database created by the SB09 E2E/DB fixtures.
begin;

do $guard$
begin
  if current_database() !~ '^azsou_test_cmsarticle_[0-9]+$'
     or pg_catalog.pg_is_in_recovery()
     or pg_catalog.getdatabaseencoding() <> 'UTF8'
     or pg_catalog.to_regclass('private.cms_article_items') is null
     or pg_catalog.to_regclass('private.cms_article_revisions') is null
     or pg_catalog.to_regclass('private.cms_article_release_events') is null
     or pg_catalog.to_regprocedure('public.az_cms_transition_article_release(text,text,integer,integer,uuid)') is null then
    raise exception using errcode = '22023', message = 'requires the disposable SB09 release database';
  end if;
end;
$guard$;

-- Public projection only: no draft pointer, actor, timestamps, item id, or event
-- history. body_source is deliberately returned as plain text; the browser reader
-- must use textContent and never treat it as HTML.
create function public.az_cms_read_published_article(p_slug text)
returns table (slug text, revision integer, title text, body_text text)
language sql
stable
security definer
set search_path = '' as $reader$
  select a.slug,
         r.revision,
         r.fields->>'title' as title,
         r.body_source as body_text
    from private.cms_article_items as a
    join lateral (
      select e.phase, e.published_revision
        from private.cms_article_release_events as e
       where e.item_id = a.id
       order by e.release_version desc
       limit 1
    ) as latest
      on latest.phase in ('published', 'review')
     and latest.published_revision is not null
     and latest.published_revision = a.published_revision
    join private.cms_article_revisions as r
      on r.item_id = a.id
     and r.revision = a.published_revision
   where p_slug = a.slug
     and a.published_revision is not null
     and exists (
       select 1
         from private.cms_article_release_events as prior
        where prior.item_id = a.id
          and prior.action = 'publish'
          and prior.published_revision = a.published_revision
     );
$reader$;

-- The function is the only new public surface. Private tables remain without
-- anon/authenticated/service_role table privileges, as established by SB03/SB09.
revoke all on function public.az_cms_read_published_article(text)
  from public, anon, authenticated, service_role;
grant execute on function public.az_cms_read_published_article(text)
  to anon, authenticated;
commit;
