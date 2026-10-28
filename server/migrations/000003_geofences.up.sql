-- The partner's zones (/geofences): a circle (center + radius) or a polygon.
-- `area` is the shape either way, so "is this point inside" is one query.

CREATE TABLE geofences (
    id              integer PRIMARY KEY,         -- partner zone_id
    org_id          text NOT NULL REFERENCES organisations (id),
    name            text NOT NULL,
    zone_type       text,
    zone_action     text,
    status          text,
    alerts_enabled  boolean NOT NULL DEFAULT false,
    center          geography(Point, 4326),      -- circles
    radius_m        real CHECK (radius_m IS NULL OR radius_m > 0),
    boundary        geometry(Polygon, 4326),     -- polygons
    area            geography(Geometry, 4326) GENERATED ALWAYS AS (
                        CASE
                            WHEN boundary IS NOT NULL THEN boundary::geography
                            WHEN center IS NOT NULL AND radius_m IS NOT NULL THEN ST_Buffer(center, radius_m)
                        END
                    ) STORED,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (boundary IS NOT NULL OR (center IS NOT NULL AND radius_m IS NOT NULL))
);
CREATE INDEX geofences_area ON geofences USING gist (area);
CREATE INDEX geofences_org ON geofences (org_id);
