-- Per-unit fleet-day tallies (the partner's /trips is not enabled for this
-- key, so km and trips are worked out from positions), and the poller's
-- bookkeeping.

CREATE TABLE vehicle_days (
    day          date NOT NULL,                  -- the fleet day (UTC+3)
    vehicle_id   integer NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
    driver_name  text,
    km           real NOT NULL DEFAULT 0 CHECK (km >= 0),
    trips        integer NOT NULL DEFAULT 0 CHECK (trips >= 0),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, vehicle_id)
);
CREATE INDEX vehicle_days_vehicle ON vehicle_days (vehicle_id, day DESC);

-- Fleet days already filled from position history (Poller.backfill).
CREATE TABLE backfilled_days (
    day        date PRIMARY KEY,
    filled_at  timestamptz NOT NULL DEFAULT now()
);

-- Small named values the poller keeps between restarts (the events cursor).
CREATE TABLE sync_state (
    key         text PRIMARY KEY,
    value       text NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
