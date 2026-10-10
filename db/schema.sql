-- Contract gateway schema (PostgreSQL 16). Applied automatically by docker-compose on first start.

create table if not exists plans (
  id              text primary key,                 -- basic | pro | enterprise
  name            text not null,
  monthly_credits integer not null,
  overage_allowed boolean not null default false,
  overage_limit   integer not null default 0,       -- how far below zero credits may go
  price_cents     integer not null default 0
);

insert into plans (id, name, monthly_credits, overage_allowed, overage_limit, price_cents) values
  ('basic', '基础版', 1000, false, 0, 0),
  ('pro', '专业版', 20000, true, 10000, 2900),
  ('enterprise', '企业版', 200000, true, 1000000, 29900)
on conflict (id) do nothing;

create table if not exists users (
  id          bigserial primary key,
  email       text unique not null,
  plan_id     text not null references plans(id) default 'basic',
  credits     integer not null default 0,           -- current balance (can go negative only with overage)
  period_end  timestamptz not null default (now() + interval '1 month'),
  created_at  timestamptz not null default now()
);

create table if not exists api_keys (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  key_hash    text unique not null,                 -- sha256(ct_…); the key itself is shown once
  hint        text not null,                        -- ct_ab…wxyz
  name        text not null default 'default',
  per_minute  integer not null default 60,
  ip_allow    text[] not null default '{}',         -- empty = any IP
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

-- Every credit movement: grants, top-ups, charges. users.credits is the running total.
create table if not exists credit_ledger (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  delta       integer not null,
  reason      text not null,                        -- monthly_grant | topup | charge:<tool>
  usage_id    bigint,
  created_at  timestamptz not null default now()
);

create table if not exists usage_events (
  id           bigserial primary key,
  user_id      bigint not null references users(id) on delete cascade,
  key_id       bigint not null references api_keys(id) on delete cascade,
  tool         text not null,
  category     text not null,
  providers    text[] not null default '{}',        -- who actually answered, in order
  failed_over  jsonb not null default '[]',         -- [{provider, error}]
  ok           boolean not null,
  streamed     boolean not null default false,
  ms           integer not null,
  credits      integer not null,
  ip           inet,
  created_at   timestamptz not null default now()
);
create index if not exists usage_events_user_time on usage_events (user_id, created_at desc);
create index if not exists usage_events_key_time on usage_events (key_id, created_at desc);

-- Rolled up nightly by the worker for the billing view.
create table if not exists usage_daily (
  user_id   bigint not null references users(id) on delete cascade,
  day       date not null,
  category  text not null,
  tool      text not null,
  calls     integer not null,
  errors    integer not null,
  credits   integer not null,
  primary key (user_id, day, tool)
);

create table if not exists provider_health_log (
  id          bigserial primary key,
  provider    text not null,
  event       text not null,                        -- failure | cooldown | recovered | probe_ok | probe_fail
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists provider_health_log_time on provider_health_log (created_at desc);
