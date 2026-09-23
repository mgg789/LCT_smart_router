-- D-1 (context/35 section 4.2) gives the engineer assistant a proper offline action
-- during a running LIVE workday. Reusing `no_show_offline` for it would render "Не вышел
-- на линию" on the dispatcher's screen for someone who did work part of the day, which is
-- a false statement -- this codebase keeps a state meaning exactly what it says. This
-- value alone distinguishes a deliberate mid-day stand-down from the automatic no-show
-- sweep.
--
-- `ALTER TYPE ... ADD VALUE` cannot run inside the same transaction that later uses the
-- value; nothing else in this migration does, so a single statement is enough here.
ALTER TYPE "LiveEngineerLineStatus" ADD VALUE IF NOT EXISTS 'stood_down';
