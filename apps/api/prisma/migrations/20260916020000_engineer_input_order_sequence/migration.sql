-- Input order of engineers.
--
-- The baseline picks the first suitable available engineer in the order they appear in
-- the input (context/33 section 5). Like the arrival order of requests, that order is a
-- business fact and must not be reconstructed later from a technical sort.
--
-- A deliberate full reset restarts this sequence together with the data it numbers.
CREATE SEQUENCE IF NOT EXISTS engineer_input_order_seq AS bigint START WITH 0 MINVALUE 0;

GRANT USAGE, SELECT, UPDATE ON SEQUENCE engineer_input_order_seq TO sys_app;
