CREATE TABLE "weather_risk_predictions" (
    "plan_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "engineer_id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "transport_type" "TransportType" NOT NULL,
    "weather_kind" TEXT NOT NULL,
    "work_date" TEXT NOT NULL,
    "candidate_version" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "router_context_version" TEXT NOT NULL,
    "predicted_at" BIGINT NOT NULL,
    "baseline_probability" DOUBLE PRECISION NOT NULL,
    "candidate_probability" DOUBLE PRECISION NOT NULL,
    "actual_breach" BOOLEAN,
    "resolved_at" BIGINT,

    CONSTRAINT "weather_risk_predictions_pkey" PRIMARY KEY ("plan_id", "request_id", "candidate_version"),
    CONSTRAINT "weather_risk_predictions_probability_range" CHECK (
        "baseline_probability" >= 0 AND "baseline_probability" <= 1 AND
        "candidate_probability" >= 0 AND "candidate_probability" <= 1
    )
);

CREATE INDEX "weather_risk_predictions_validation_idx"
    ON "weather_risk_predictions"("region", "transport_type", "weather_kind", "work_date", "candidate_version");
