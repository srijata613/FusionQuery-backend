require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const migrations = [
  // ── USERS ────────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS users (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address   VARCHAR(42) UNIQUE NOT NULL,
    role             VARCHAR(20) NOT NULL DEFAULT 'donor'
                       CHECK (role IN ('donor','charity','institution','admin')),
    display_name     VARCHAR(200),
    email            VARCHAR(255),
    is_active        BOOLEAN NOT NULL DEFAULT true,
    last_login_at    TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address)`,

  // ── PROJECTS ─────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS projects (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    charity_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title                VARCHAR(200) NOT NULL,
    description          TEXT NOT NULL,
    category             VARCHAR(50) NOT NULL,
    target_amount        NUMERIC(28,8) NOT NULL CHECK (target_amount > 0),
    raised_amount        NUMERIC(28,8) NOT NULL DEFAULT 0,
    currency             VARCHAR(10) NOT NULL DEFAULT 'MATIC',
    beneficiary_address  VARCHAR(42) NOT NULL,
    status               VARCHAR(20) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('draft','active','completed','cancelled')),
    end_date             TIMESTAMPTZ,
    contract_project_id  VARCHAR(66),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS idx_projects_charity   ON projects(charity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_status    ON projects(status)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_category  ON projects(category)`,

  // ── MILESTONES ────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS milestones (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title             VARCHAR(200) NOT NULL,
    description       TEXT NOT NULL,
    target_amount     NUMERIC(28,8) NOT NULL CHECK (target_amount > 0),
    order_index       SMALLINT NOT NULL DEFAULT 1,
    status            VARCHAR(30) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','proof_submitted','verified','released','failed')),
    proof_ipfs_hash   VARCHAR(100),
    proof_description TEXT,
    due_date          TIMESTAMPTZ,
    released_at       TIMESTAMPTZ,
    release_tx_hash   VARCHAR(66),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id)`,

  // ── DONATIONS ─────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS donations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    donor_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    donor_wallet   VARCHAR(42) NOT NULL,
    amount         NUMERIC(28,8) NOT NULL CHECK (amount > 0),
    tx_hash        VARCHAR(66) UNIQUE NOT NULL,
    message        TEXT,
    anonymous      BOOLEAN NOT NULL DEFAULT false,
    status         VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('pending','confirmed','failed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_donations_project ON donations(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_donations_wallet  ON donations(donor_wallet)`,
  `CREATE INDEX IF NOT EXISTS idx_donations_tx      ON donations(tx_hash)`,

  // ── CERTIFICATES ──────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS certificates (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    recipient_wallet  VARCHAR(42) NOT NULL,
    recipient_name    VARCHAR(200) NOT NULL,
    course_title      VARCHAR(300) NOT NULL,
    institution_name  VARCHAR(300) NOT NULL,
    grade             VARCHAR(20),
    completion_date   TIMESTAMPTZ NOT NULL,
    expiry_date       TIMESTAMPTZ,
    skills            JSONB NOT NULL DEFAULT '[]',
    ipfs_hash         VARCHAR(100),
    metadata_url      TEXT,
    token_id          VARCHAR(78),
    tx_hash           VARCHAR(66),
    revoke_tx_hash    VARCHAR(66),
    revoke_reason     TEXT,
    status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','issued','revoked','failed')),
    issued_at         TIMESTAMPTZ,
    revoked_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS idx_certs_recipient ON certificates(recipient_wallet)`,
  `CREATE INDEX IF NOT EXISTS idx_certs_issuer    ON certificates(issuer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_certs_status    ON certificates(status)`,

  // ── TRANSACTIONS ──────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS transactions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_hash       VARCHAR(66) UNIQUE NOT NULL,
    event_type    VARCHAR(50) NOT NULL,
    project_id    UUID REFERENCES projects(id) ON DELETE SET NULL,
    cert_id       UUID REFERENCES certificates(id) ON DELETE SET NULL,
    from_address  VARCHAR(42),
    to_address    VARCHAR(42),
    amount        NUMERIC(28,8),
    block_number  BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_txns_project    ON transactions(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_txns_event_type ON transactions(event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_txns_from       ON transactions(from_address)`,

  // ── HELPER FUNCTION: updated_at trigger ───────────────────────────────────────
  `CREATE OR REPLACE FUNCTION set_updated_at()
   RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $$ LANGUAGE plpgsql`,

  ...[
    'users', 'projects', 'milestones', 'certificates',
  ].map((t) => `
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_${t}_updated_at'
      ) THEN
        CREATE TRIGGER trg_${t}_updated_at
        BEFORE UPDATE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      END IF;
    END $$
  `),
];

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Running TrustChain migrations...');
    await client.query('BEGIN');

    for (const sql of migrations) {
      await client.query(sql);
    }

    await client.query('COMMIT');
    console.log('✅ Migrations completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
