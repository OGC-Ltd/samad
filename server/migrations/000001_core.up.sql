-- Extensions, the organisation and the sign-in accounts.
--
-- Samad Resources is the only organisation; every fleet table still carries
-- org_id so a second one never needs a schema change.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE organisations (
    id          text PRIMARY KEY,                -- "samad": the id the API routes use
    code        text NOT NULL UNIQUE,            -- "SAMAD"
    name        text NOT NULL,
    utc_offset  interval NOT NULL DEFAULT '3 hours', -- where a fleet day starts
    created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organisations (id, code, name) VALUES ('samad', 'SAMAD', 'Samad Resources');

-- Today the one account lives in server/.env; this table is where accounts
-- go once there is more than one.
CREATE TABLE users (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id         text NOT NULL REFERENCES organisations (id),
    email          citext NOT NULL UNIQUE,
    name           text NOT NULL,
    password_hash  text NOT NULL,                -- bcrypt, as `samad-server hash-password` prints
    role           text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator', 'viewer')),
    disabled_at    timestamptz,
    last_login_at  timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
