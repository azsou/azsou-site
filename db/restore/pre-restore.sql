-- =============================================================================
-- db/restore/pre-restore.sql — 「整库恢复」之前在目标库执行一次（Supabase 新项目或已跑过 shim 的 Postgres）。
-- public 备份里的索引 / 函数引用了 extensions schema 里的扩展，但扩展本身不在 public 备份中。
-- =============================================================================
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
