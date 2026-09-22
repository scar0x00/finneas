-- ============================================================================
-- Finneas — Finances DB schema
-- Target: PostgreSQL (Neon), database `finneas`
-- Source: issue #1, comment 5747545688 (first-draft proposal)
--
--
-- Naming: FK columns follow the draft's own `user_id` convention, so the
-- draft's `counterparty`, `finnacial_instrument` (sic), `owner` and
-- `financial_provider` columns become `counterparty_id`,
-- `financial_instrument_id`, `owner_id` and `financial_provider_id`.
-- `DECIMAL` is written as `NUMERIC` (same type in Postgres).
--
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS finneas;
SET search_path TO finneas;

-- ----------------------------------------------------------------------------
-- Enum types
-- ----------------------------------------------------------------------------

-- movement_type: identifies what this entry is.
CREATE TYPE movement_type AS ENUM (
    'income',
    'egress',
    'lend',
    'borrow',
    'currency_conversion',
    'self_transfer' -- user moves funds from one account to another with the same currency
);

CREATE TYPE currency_type AS ENUM ('fiat', 'crypto');

-- Payment channels. The movements entry in the draft says "pago_movil,
-- transfer?"; the full value list below is the one defined later in the same
-- comment.
CREATE TYPE payment_channel_enum AS ENUM (
    'pago_movil',
    'transferencia_bancaria_interna',
    'transferencia_interbancaria',
    'consumo_tdc',
    'binance_pay'
);

CREATE TYPE provider_types AS ENUM ('bank', 'crypto_exchange');

CREATE TYPE counterparty_visibility AS ENUM ('private', 'public');

CREATE TYPE loan_status AS ENUM ('open', 'settled', 'written_off');


-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
-- Referenced by movements, financial_instruments and counterparties but not
-- defined in the draft comment. Minimal placeholder so the foreign keys are
-- valid; its real definition (fields, Telegram identity, etc.) is still to be
-- designed — see the follow-up comment on issue #1.
CREATE TABLE users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tg_id bigint UNIQUE NOT NULL
);


-- ----------------------------------------------------------------------------
-- currencies
-- ----------------------------------------------------------------------------
-- Access pattern: each row will be probably written once and then only
-- queried. Way more reads (really by a lot) than writes.
CREATE TABLE currencies (
    currency_code varchar(6)      PRIMARY KEY,  -- 6-character code for the currency
    currency_name varchar(20),                  -- currency friendly name
    issuer        text,                         -- who issues the currency
    currency_type currency_type                 -- crypto or fiat
);


-- ----------------------------------------------------------------------------
-- conversion_rates
-- ----------------------------------------------------------------------------
-- All currencies have a row listing their conversion rate towards the USD.
-- Access pattern: every row will be re-written periodically, probably more
-- than once every hour; still more read than written to. The draft suggests
-- it may be more convenient to implement in Upstash or Cloudflare KV.
CREATE TABLE conversion_rates (
    currency_code   varchar(6)      NOT NULL UNIQUE REFERENCES currencies(currency_code),
    conversion_rate numeric(78, 36) NOT NULL, -- 1 unit = X USD
    last_updated    timestamptz     NOT NULL
);

ALTER TABLE conversion_rates
    ADD COLUMN rate_name TEXT NOT NULL;

ALTER TABLE conversion_rates
    ADD CONSTRAINT unique_rate_name_and_currency_code
    UNIQUE (currency_code, rate_name);


-- ----------------------------------------------------------------------------
-- conversion_rates_historical (NOT created here)
-- ----------------------------------------------------------------------------
-- The draft proposes possibly implementing this as Parquet files in S3/GCS
-- queried through DuckDB, with a cache of the rates from the last 60 days on
-- KV/Upstash. No table structure is given in the comment, so nothing is
-- created for it in this file.


-- ----------------------------------------------------------------------------
-- currency_issuers (NOT created here)
-- ----------------------------------------------------------------------------
-- "Central banks, exchanges, blockchains, etc" — marked as STILL FIGURING OUT
-- IF NECESSARY in the draft. For now currencies.issuer holds this as free
-- text. No table is created.


-- ----------------------------------------------------------------------------
-- financial_providers
-- ----------------------------------------------------------------------------
-- Banks, wallets, exchange service providers and anywhere or anything where
-- money of a given currency can be saved, sent or received.
-- Access pattern: each row will be probably written once and then only
-- queried. Way more reads (really by a lot) than writes.
create table finneas.financial_providers (
  id bigint generated by default as identity not null,
  provider_type finneas.provider_types null,
  name text not null,
  description text null,
  friendly_name text not null,

  constraint financial_providers_pkey primary key (id),
  constraint financial_providers_friendly_name_key unique (friendly_name)
)


-- ----------------------------------------------------------------------------
-- financial_instruments
-- ----------------------------------------------------------------------------
-- Accounts, wallets and other financial products the person uses to save,
-- send and receive money.
-- For consistent balance calculations, a per-user cash instrument will be created
CREATE TABLE financial_instruments (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                  varchar(100),
    currency_code         varchar(6) NOT NULL REFERENCES currencies(currency_code),
    owner_id              bigint NOT NULL REFERENCES users(id),
    description           text,
    financial_provider_id bigint REFERENCES financial_providers(id)
);


-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- counterparties
-- ----------------------------------------------------------------------------
-- Populated as users register expenses/payments. PUBLIC counterparties (big
-- brands/stores, service providers like ISPs, Netflix, etc.) can be
-- registered as the payee or payer of movements of any user, so owner_id is
-- nullable; PRIVATE ones belong to a single user.
CREATE TABLE counterparties (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        varchar(80),
    description text,
    owner_id    bigint REFERENCES users(id),
    visibility  counterparty_visibility NOT NULL DEFAULT 'private',
    CHECK (
        (visibility = 'public' AND owner_id IS NULL)
        OR
        (visibility = 'private' AND owner_id IS NOT NULL)
    )
);

ALTER TABLE counterparties
    ADD CONSTRAINT unique_counterparties_name
    UNIQUE (name);


--- new tables

CREATE TYPE loan_direction AS ENUM ('in_favor', 'against');  -- receivable / liability

CREATE TABLE loans (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id            bigint  NOT NULL REFERENCES users(id),
    counterparty_id    bigint  NOT NULL REFERENCES counterparties(id),
    direction          loan_direction NOT NULL,
    principal_amount   numeric(78, 36) NOT NULL,          -- always in principal_currency
    principal_currency varchar(6) NOT NULL REFERENCES currencies(currency_code),
    origin_movement_id bigint, -- the lend/borrow cash leg
    description        text,
    due_date           timestamptz,                     -- feeds the reminder job
    status             loan_status NOT NULL DEFAULT 'open',
    settled_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),


    CHECK (principal_amount > 0),
    CHECK ((status = 'settled') = (settled_at IS NOT NULL))
);

-- enforce "you can only tag movements with your own loan":
ALTER TABLE loans ADD UNIQUE (id, user_id);

-- ----------------------------------------------------------------------------
-- movements
-- ----------------------------------------------------------------------------
-- Access pattern: new rows will be written every day, although probably won't
-- be hundreds of rows per day (for a regular user). Not sure if there'll be
-- heavy reading to it; this pattern will vary among users.
--
--
-- Conversion rate can be derived from: to_amount / from_amount if currencies are not the same
CREATE TABLE movements (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id),
    movement_type movement_type NOT NULL,
    made_at timestamptz NOT NULL,
    registered_at timestamptz NOT NULL,
    from_instrument_id bigint
        REFERENCES financial_instruments(id),
    to_instrument_id bigint
        REFERENCES financial_instruments(id),
    from_amount numeric(78, 36),
    from_currency varchar(6)
        REFERENCES currencies(currency_code),
    to_amount numeric(78, 36),
    to_currency varchar(6)
        REFERENCES currencies(currency_code),
    counterparty_id bigint
        REFERENCES counterparties(id),
    payment_channel payment_channel_enum,
    description text,
    loan_id bigint,
    loan_applied      numeric(78, 36),   -- amount applied, in the LOAN's currency
    loan_applied_rate numeric(78, 36),  -- rate used if repayment currency ≠ loan currency

    CHECK (
        from_instrument_id IS NOT NULL
        OR to_instrument_id IS NOT NULL
    ),
    CHECK (
        (from_instrument_id IS NULL
         AND from_amount IS NULL
         AND from_currency IS NULL)
        OR
        (from_instrument_id IS NOT NULL
         AND from_amount IS NOT NULL
         AND from_currency IS NOT NULL)
    ),
    CHECK (
        (to_instrument_id IS NULL
         AND to_amount IS NULL
         AND to_currency IS NULL)
        OR
        (to_instrument_id IS NOT NULL
         AND to_amount IS NOT NULL
         AND to_currency IS NOT NULL)
    ),
    CHECK (from_amount IS NULL OR from_amount > 0),
    CHECK (to_amount IS NULL OR to_amount > 0),
    CHECK ((loan_id IS NULL) = (loan_applied IS NULL)),

    CHECK (loan_applied IS NULL OR loan_applied > 0),
    CHECK (loan_applied_rate IS NULL OR loan_applied_rate > 0),
    CHECK (loan_applied_rate IS NULL OR loan_id IS NOT NULL),

    CHECK (loan_id IS NULL OR movement_type IN ('income', 'egress'))
);


ALTER TABLE movements ADD UNIQUE (id, user_id);

ALTER TABLE loans
    ADD CONSTRAINT loans_origin_movement_owner_fk
    FOREIGN KEY (origin_movement_id, user_id)
    REFERENCES movements(id, user_id);


ALTER TABLE movements ADD FOREIGN KEY (loan_id, user_id) REFERENCES loans(id, user_id);

ALTER TABLE financial_instruments
    ADD CONSTRAINT financial_instruments_id_owner_unique
    UNIQUE (id, owner_id);

ALTER TABLE movements
    ADD CONSTRAINT movements_from_instrument_owner_fk
    FOREIGN KEY (from_instrument_id, user_id)
    REFERENCES financial_instruments(id, owner_id);

ALTER TABLE movements
    ADD CONSTRAINT movements_to_instrument_owner_fk
    FOREIGN KEY (to_instrument_id, user_id)
    REFERENCES financial_instruments(id, owner_id);

-- CREATE INDEX movements_loan_idx ON movements(loan_id) WHERE loan_id IS NOT NULL;
-- CREATE INDEX loans_open_idx     ON loans(user_id, due_date) WHERE status = 'open';
-- CREATE INDEX ON movements(user_id, made_at DESC);


-- NOTE:
-- Know your CHECK limits: a few invariants need cross-table lookups and can't
-- be plain CHECKs — instrument currency vs. movement currency consistency, 
-- self_transfer same-currency, repayment direction matching loan direction 
-- (income for in_favor, egress for against), and "origin movement must be a 
-- lend/borrow". Those belong in the app layer (or a trigger later). Worth a 
-- comment in the file so nobody assumes the schema enforces them.