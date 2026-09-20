-- ============================================================================
-- Finneas — Finances DB schema
-- Target: PostgreSQL (Neon), database `finneas`
-- Source: issue #1, comment 5747545688 (first-draft proposal)
--
-- This file implements ONLY the draft from that comment. The remarks from the
-- follow-up review comment (5747574617) are deliberately NOT applied yet.
--
-- Naming: FK columns follow the draft's own `user_id` convention, so the
-- draft's `counterparty`, `finnacial_instrument` (sic), `owner` and
-- `financial_provider` columns become `counterparty_id`,
-- `financial_instrument_id`, `owner_id` and `financial_provider_id`.
-- `DECIMAL` is written as `NUMERIC` (same type in Postgres).
--
-- Nullability: the draft specifies none, so NOT NULL was only applied where a
-- row is meaningless without the field (PKs and the core movement fields);
-- everything else stays nullable.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Enum types
-- ----------------------------------------------------------------------------

-- movement_type: identifies what this entry is. Did money enter the financial
-- instrument or the opposite? Did the user borrow money, or lend it?
CREATE TYPE movement_type AS ENUM ('income', 'egress', 'lend', 'borrow');

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

CREATE TYPE counter_party_visibility AS ENUM ('private', 'public');


-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
-- Referenced by movements, financial_instruments and counterparties but not
-- defined in the draft comment. Minimal placeholder so the foreign keys are
-- valid; its real definition (fields, Telegram identity, etc.) is still to be
-- designed — see the follow-up comment on issue #1.
CREATE TABLE users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
);


-- ----------------------------------------------------------------------------
-- currencies
-- ----------------------------------------------------------------------------
-- Access pattern: each row will be probably written once and then only
-- queried. Way more reads (really by a lot) than writes.
CREATE TABLE currencies (
    currency_code varchar(3)      PRIMARY KEY,  -- 3-character code for the currency
    currency_name varchar(20),                  -- currency friendly name
    issuer        text,                         -- who issues the currency
    type          currency_type                 -- crypto or fiat
);


-- ----------------------------------------------------------------------------
-- conversion_rates
-- ----------------------------------------------------------------------------
-- All currencies have a row listing their conversion rate towards the USD.
-- Access pattern: every row will be re-written periodically, probably more
-- than once every hour; still more read than written to. The draft suggests
-- it may be more convenient to implement in Upstash or Cloudflare KV.
CREATE TABLE conversion_rates (
    currency_code   varchar(3)      NOT NULL UNIQUE REFERENCES currencies(currency_code),
    conversion_rate numeric(40, 25) NOT NULL,
    last_updated    timestamptz     NOT NULL
);

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
CREATE TABLE financial_providers (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_type provider_types,
    name          text NOT NULL,
    description   text
);


-- ----------------------------------------------------------------------------
-- financial_instruments
-- ----------------------------------------------------------------------------
-- Accounts, wallets and other financial products the person uses to save,
-- send and receive money.
CREATE TABLE financial_instruments (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                  varchar(100),
    owner_id              bigint REFERENCES users(id),
    user_description      text,
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
    visibility  counter_party_visibility,
    owner_id    bigint REFERENCES users(id)
);


-- ----------------------------------------------------------------------------
-- movements
-- ----------------------------------------------------------------------------
-- Access pattern: new rows will be written every day, although probably won't
-- be hundreds of rows per day (for a regular user). Not sure if there'll be
-- heavy reading to it; this pattern will vary among users.
--
-- TODO (from the draft): the financial instrument must belong to the same user
-- registering the movement. A plain FK cannot express that invariant; it will
-- need a composite FK or a trigger once the draft is validated.
--
-- NOTE: the draft says amount is DECIMAL(18, 3) "with fixed decimal point
-- (2 decimal digits)", which is contradictory; scale 3 is kept as written.
CREATE TABLE movements (
    id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id                 bigint         NOT NULL REFERENCES users(id),
    amount                  numeric(18, 3) NOT NULL,
    currency                varchar(3)     NOT NULL REFERENCES currencies(currency_code),
    made_at                 timestamptz    NOT NULL,
    counterparty_id         bigint         REFERENCES counterparties(id),
    financial_instrument_id bigint         REFERENCES financial_instruments(id),
    payment_channel         payment_channel_enum,
    description             text,          -- natural language description, filled by the AI model
    type                    movement_type  NOT NULL
);
