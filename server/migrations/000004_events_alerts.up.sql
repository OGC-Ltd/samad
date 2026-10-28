-- The partner's events feed (/events, cursor paged) and what people do with
-- the alerts it raises: decisions (escalate / de-escalate) and read marks.

CREATE TABLE events (
    id                 text PRIMARY KEY,         -- partner event_id
    org_id             text NOT NULL REFERENCES organisations (id),
    vehicle_id         integer REFERENCES vehicles (id) ON DELETE SET NULL,
    source             text NOT NULL,            -- device (dashcam) / platform
    type               text NOT NULL,            -- no_seatbelt, phone_use, over_speeding…
    type_label         text,
    alarm_code         integer,
    severity           text NOT NULL CHECK (severity IN ('critical', 'warning', 'informational')),
    occurred_at        timestamptz NOT NULL,
    received_at        timestamptz NOT NULL,
    registration       text,
    device_imei        text,
    location           geography(Point, 4326),
    speed_kmh          real,
    clip_road_url      text,                     -- dashcam clips on the partner's video host
    clip_driver_url    text,
    geofence_id        integer,                  -- no FK: a zone may be deleted upstream first
    geofence_name      text,
    geofence_action    text,
    raw                jsonb NOT NULL,           -- the event as the partner sent it
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_org_occurred ON events (org_id, occurred_at DESC);
CREATE INDEX events_vehicle_occurred ON events (vehicle_id, occurred_at DESC);
CREATE INDEX events_type ON events (type);
-- The Camera page: dashcam alarms with a clip.
CREATE INDEX events_camera_occurred ON events (occurred_at DESC)
    WHERE source = 'device' AND (clip_road_url IS NOT NULL OR clip_driver_url IS NOT NULL);

-- Every decision is kept; the latest one is the alert's status.
CREATE TABLE alert_decisions (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id    text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    outcome     text NOT NULL CHECK (outcome IN ('ESCALATED', 'DEESCALATED')),
    reason      text,
    note        text NOT NULL DEFAULT '',
    decided_by  citext NOT NULL,                 -- the account's email
    decided_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_decisions_event ON alert_decisions (event_id, decided_at DESC);

-- One alert read by one account.
CREATE TABLE alert_reads (
    user_email  citext NOT NULL,
    event_id    text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    read_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_email, event_id)
);

-- "Mark all read": everything that arrived before read_before counts as read.
CREATE TABLE alert_read_all (
    user_email   citext PRIMARY KEY,
    read_before  timestamptz NOT NULL
);
