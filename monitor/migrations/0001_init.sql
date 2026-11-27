-- Breakglass monitor store. Amounts are NUMERIC (u64 doesn't fit BIGINT) and
-- are returned to API clients as decimal strings.

CREATE TABLE protocols (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    breakglass_program  TEXT NOT NULL,
    protected_program   TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every decoded Breakglass event, once (deduped across RPCs).
CREATE TABLE events (
    id           BIGSERIAL PRIMARY KEY,
    protocol_id  INT NOT NULL REFERENCES protocols(id),
    kind         TEXT NOT NULL,
    signature    TEXT NOT NULL,
    event_index  INT NOT NULL,
    slot         BIGINT NOT NULL,
    block_time   TIMESTAMPTZ,
    data         JSONB NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (signature, event_index)
);
CREATE INDEX events_kind ON events (kind, id);
CREATE INDEX events_signature ON events (signature);

-- One incident per root cause (dedupe_key).
CREATE TABLE incidents (
    id             BIGSERIAL PRIMARY KEY,
    protocol_id    INT NOT NULL REFERENCES protocols(id),
    detector       TEXT NOT NULL,
    severity       TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'high', 'critical')),
    title          TEXT NOT NULL,
    dedupe_key     TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acked', 'resolved')),
    opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    acked_by       TEXT,
    acked_at       TIMESTAMPTZ,
    signatures     TEXT[] NOT NULL DEFAULT '{}',
    last_paged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    page_count     INT NOT NULL DEFAULT 1,
    escalated      BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX incidents_active ON incidents (protocol_id, dedupe_key) WHERE status <> 'resolved';
CREATE INDEX incidents_status ON incidents (status, id);

-- Every delivery attempt, per sink.
CREATE TABLE alerts (
    id           BIGSERIAL PRIMARY KEY,
    incident_id  BIGINT REFERENCES incidents(id),
    sink         TEXT NOT NULL,
    sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ok           BOOLEAN NOT NULL,
    error        TEXT
);
CREATE INDEX alerts_incident ON alerts (incident_id);

CREATE TABLE acks (
    id           BIGSERIAL PRIMARY KEY,
    incident_id  BIGINT NOT NULL REFERENCES incidents(id),
    acked_by     TEXT NOT NULL,
    note         TEXT,
    at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mirror of Breakglass PendingWithdrawal accounts (refreshed on every hold event).
CREATE TABLE holds (
    id           BIGSERIAL PRIMARY KEY,
    protocol_id  INT NOT NULL REFERENCES protocols(id),
    address      TEXT NOT NULL UNIQUE,
    owner        TEXT NOT NULL,
    mint         TEXT NOT NULL,
    amount       NUMERIC(20, 0) NOT NULL,
    nonce        NUMERIC(20, 0) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL,
    release_at   TIMESTAMPTZ NOT NULL,
    status       TEXT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX holds_owner ON holds (owner, id);
