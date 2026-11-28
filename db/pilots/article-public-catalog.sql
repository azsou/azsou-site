-- SB10 catalog pilot: disposable CI article database only. Not a migration or hosted installer.
begin;

do $guard$
begin
  if pg_catalog.current_database() !~ '^azsou_test_cmsarticle_[0-9]+$'
     or pg_catalog.pg_is_in_recovery()
     or pg_catalog.getdatabaseencoding() <> 'UTF8'
     or pg_catalog.to_regclass('private.cms_article_items') is null
     or pg_catalog.to_regprocedure('public.az_cms_read_published_article(text)') is null then
    raise exception using errcode = '22023', message = 'requires the disposable SB10 public-reader fixture';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc as p
     where p.pronamespace = 'public'::pg_catalog.regnamespace
       and p.proname = 'az_cms_list_published_articles'
  ) then
    raise exception using errcode = '42710', message = 'catalog name already in use';
  end if;
end;
$guard$;

-- The existing per-slug reader, not the mutable draft or the pointer alone, decides visibility.
-- Slugs are unique. NULL starts the first page; non-NULL cursors are exclusive under C collation.
-- This pilot accepts 1..50 rows. Invalid bounds/cursors yield zero rows, never an unbounded page.
create function public.az_cms_list_published_articles(p_after_slug text, p_limit integer)
returns table (slug text, revision integer, title text)
language sql stable security definer
set search_path = '' as $catalog$
  select live.slug, live.revision, live.title
    from private.cms_article_items as a
    cross join lateral public.az_cms_read_published_article(a.slug) as live
   where a.published_revision is not null
     and live.slug = a.slug
     and live.revision = a.published_revision
     and case
           when p_after_slug is null then true
           when pg_catalog.octet_length(p_after_slug) not between 1 and 80 then false
           else p_after_slug collate pg_catalog."C" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
             and a.slug collate pg_catalog."C" > p_after_slug collate pg_catalog."C"
         end
   order by a.slug collate pg_catalog."C"
   limit case when p_limit between 1 and 50 then p_limit else 0 end;
$catalog$;

revoke all on function public.az_cms_list_published_articles(text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.az_cms_list_published_articles(text,integer)
  to anon, authenticated;

-- Fail the installation transaction if default ACLs grant extra callers or delegation.
do $acl$
declare
  f oid := 'public.az_cms_list_published_articles(text,integer)'::pg_catalog.regprocedure;
begin
  if not pg_catalog.has_function_privilege('anon', f, 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', f, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', f, 'EXECUTE')
     or exists (
       select 1 from pg_catalog.pg_proc as p
       cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) as g
        where p.oid = f and g.grantee <> p.proowner
          and (g.grantee not in ('anon'::pg_catalog.regrole, 'authenticated'::pg_catalog.regrole)
               or g.is_grantable or g.privilege_type <> 'EXECUTE')
     ) then
    raise exception using errcode = '42501', message = 'unexpected catalog execute privileges';
  end if;
end;
$acl$;
commit;
