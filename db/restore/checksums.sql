-- =============================================================================
-- db/restore/checksums.sql — 逐表「行数 + 内容 md5」（备份时在统一快照里执行；精确恢复在事务里用同一列清单复算）。
-- 输出（制表符分隔，无表头）：表 \t 行数 \t md5 \t 参与计算的列（SQL 片段，按 attnum 顺序）
--   md5 = md5(string_agg(row(列…)::text, 换行 order by 文本 collate "C"))——与物理顺序、库排序规则无关。
-- 范围：public / private 全部表、auth.users、auth.identities、storage.buckets、storage.objects（存在时）。
-- 另有两条「#identity」：storage 经 API 恢复时 id / 时间戳 / eTag 会重新生成，只核对身份列
--   （桶：id name public 限额 MIME；对象：bucket_id name owner_id）。
-- =============================================================================
with t(tbl, oid) as (
  select format('%I.%I', n.nspname, c.relname), c.oid
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname in ('public', 'private') and not c.relispartition
  union all
  select x, to_regclass(x) from unnest(array['auth.users', 'auth.identities', 'storage.buckets', 'storage.objects']) x
   where to_regclass(x) is not null
), cols as (
  select t.tbl, string_agg(format('t.%I', a.attname), ',' order by a.attnum) as cl
    from t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
   group by t.tbl
  union all
  select 'storage.buckets#identity', string_agg(format('t.%I', a.attname), ',' order by a.attnum)
    from pg_attribute a where a.attrelid = to_regclass('storage.buckets') and not a.attisdropped
     and a.attname in ('id', 'name', 'public', 'file_size_limit', 'allowed_mime_types')
  having count(*) > 0
  union all
  select 'storage.objects#identity', string_agg(format('t.%I', a.attname), ',' order by a.attnum)
    from pg_attribute a where a.attrelid = to_regclass('storage.objects') and not a.attisdropped
     and a.attname in ('bucket_id', 'name', 'owner_id')
  having count(*) > 0
)
select format($q$select %L, count(*), md5(coalesce(string_agg(x, E'\n' order by x collate "C"), '')), %L from (select row(%s)::text as x from %s t) s$q$,
              tbl, cl, cl, split_part(tbl, '#', 1))
  from cols order by tbl collate "C"
\gexec
