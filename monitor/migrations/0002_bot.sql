-- Phase 6: time series of flows (velocity baseline, deposit history), the
-- guardian bot's action log, and the PendingConfig mirror.

-- kind: deposit (into a watched vault), outflow (allowed withdrawal),
-- held (a withdrawal queued as a hold), claim (a held withdrawal paid out).
CREATE TABLE flows (
    id           BIGSERIAL PRIMARY KEY,
    protocol_id  INT NOT NULL REFERENCES protocols(id),
    kind         TEXT NOT NULL CHECK (kind IN ('deposit', 'outflow', 'held', 'claim')),
    owner        TEXT NOT NULL,
    mint         TEXT NOT NULL,
    amount       NUMERIC(20, 0) NOT NULL,
    signature    TEXT,
    at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX flows_mint_at ON flows (protocol_id, mint, at);
CREATE INDEX flows_owner ON flows (protocol_id, owner, mint);

-- Every action the guardian bot attempted, and how it went.
CREATE TABLE actions (
    id            BIGSERIAL PRIMARY KEY,
    protocol_id   INT NOT NULL REFERENCES protocols(id),
    kind          TEXT NOT NULL CHECK (kind IN ('pause', 'freeze')),
    target        TEXT NOT NULL,
    reason        TEXT NOT NULL,
    triggered_by  TEXT[] NOT NULL DEFAULT '{}',
    signature     TEXT,
    ok            BOOLEAN NOT NULL,
    error         TEXT,
    at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mirror of Breakglass PendingConfig accounts (refreshed on every change event).
CREATE TABLE pending_changes (
    id             BIGSERIAL PRIMARY KEY,
    protocol_id    INT NOT NULL REFERENCES protocols(id),
    address        TEXT NOT NULL UNIQUE,
    change_id      NUMERIC(20, 0) NOT NULL,
    action_kind    TEXT NOT NULL,
    action         JSONB NOT NULL,
    proposed_by    TEXT NOT NULL,
    proposed_at    TIMESTAMPTZ NOT NULL,
    executable_at  TIMESTAMPTZ NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('pending', 'vetoed', 'executed', 'cancelled')),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
