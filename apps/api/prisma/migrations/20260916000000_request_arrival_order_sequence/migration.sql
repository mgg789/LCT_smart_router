-- Arrival order of requests.
--
-- The baseline distributes requests in the order they arrived and picks the first
-- suitable engineer in input order (context/33 section 5). That order is a business fact,
-- so it cannot be derived later from a technical sort or from a creation timestamp that
-- two concurrent submissions might share.
--
-- A sequence rather than max(arrival_order) + 1: the latter would hand the same position
-- to two submissions that commit at the same moment.
--
-- Starting at 0 matches the contract, where arrival_order is a non-negative integer.
-- A deliberate full reset restarts this sequence together with the data it numbers.
CREATE SEQUENCE IF NOT EXISTS request_arrival_order_seq AS bigint START WITH 0 MINVALUE 0;

GRANT USAGE, SELECT, UPDATE ON SEQUENCE request_arrival_order_seq TO sys_app;
