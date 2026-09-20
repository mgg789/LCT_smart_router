-- The mail catalogue grows from four to nine categories (card #65, 2026-09-20 product
-- decision): every customer-visible request transition gets a letter -- confirmed
-- engineer start, completion, cancellation, and the difference between "the customer
-- moved the window" and "the office asks to re-agree the window" -- plus one day-summary
-- letter per engineer work date. No stored row can hold the new values yet, so adding
-- them now is safe; PostgreSQL only forbids *using* a value added in the same
-- transaction, not adding it.
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'engineer_confirmed';
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'request_rescheduled';
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'request_cancelled';
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'request_completed';
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'engineer_day_summary';
