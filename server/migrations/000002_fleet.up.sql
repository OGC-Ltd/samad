-- The units, their drivers and where they have been, from the partner's
-- /vehicles, /positions and /vehicles/{id}/positions.

CREATE TABLE drivers (
    id          integer PRIMARY KEY,             -- partner driver_id
    org_id      text NOT NULL REFERENCES organisations (id),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
    id            integer PRIMARY KEY,           -- partner vehicle_id
    org_id        text NOT NULL REFERENCES organisations (id),
    registration  text NOT NULL,
    type          text,
    make          text,
    model         text,
    status        text,
    device_id     integer,
    device_imei   text,
    driver_id     integer REFERENCES drivers (id) ON DELETE SET NULL,
    owner_id      integer,
    owner_name    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicles_org_registration ON vehicles (org_id, registration);
CREATE UNIQUE INDEX vehicles_device_imei ON vehicles (device_imei) WHERE device_imei IS NOT NULL;

-- The last fix of every unit: one row each, overwritten every poll.
CREATE TABLE vehicle_positions_latest (
    vehicle_id      integer PRIMARY KEY REFERENCES vehicles (id) ON DELETE CASCADE,
    recorded_at     timestamptz NOT NULL,        -- the tracker's last_update
    location        geography(Point, 4326) NOT NULL,
    speed_kmh       real NOT NULL DEFAULT 0,
    course          real,
    engine          text,                        -- partner's engine: on / off / unknown
    motion_status   text,
    satellites      smallint,
    device_temp_c   real,
    polled_at       timestamptz NOT NULL DEFAULT now()
);

-- Every fix kept: the tracks, replays and the km and trip tallies.
CREATE TABLE vehicle_positions (
    vehicle_id   integer NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
    recorded_at  timestamptz NOT NULL,
    location     geography(Point, 4326) NOT NULL,
    speed_kmh    real NOT NULL DEFAULT 0,
    course       real,
    ignition     boolean,
    PRIMARY KEY (vehicle_id, recorded_at)
);
-- Time-ordered appends: a BRIN index stays tiny over millions of rows.
CREATE INDEX vehicle_positions_recorded_brin ON vehicle_positions USING brin (recorded_at);
CREATE INDEX vehicle_positions_location ON vehicle_positions USING gist (location);
