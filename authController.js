const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// In-memory nonce store (use Redis in production for horizontal scaling)
// Structure: { walletAddress -> { nonce, expiresAt } }
const nonceStore = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Purge expired nonces every minute
setInterval(() => {
  const now = Date.now();
  for (const [addr, data] of nonceStore) {
    if (data.expiresAt < now) nonceStore.delete(addr);
  }
}, 60_000);

/**
 * GET /auth/nonce?walletAddress=0x...
 * Generate a one-time nonce for the wallet to sign.
 */
async function getNonce(req, res) {
  const { walletAddress } = req.query;
  const normalised = walletAddress.toLowerCase();

  const nonce = uuidv4();
  const expiresAt = Date.now() + NONCE_TTL_MS;

  nonceStore.set(normalised, { nonce, expiresAt });

  const message = buildSignMessage(normalised, nonce);

  logger.info(`Nonce generated for ${normalised}`);
  res.json({
    success: true,
    data: {
      nonce,
      message, // The exact string the frontend must sign
      expiresIn: NONCE_TTL_MS / 1000,
    },
  });
}

/**
 * POST /auth/verify
 * Verify MetaMask signature, upsert user, return JWT.
 */
async function verifySignature(req, res) {
  const { walletAddress, signature, nonce } = req.body;
  const normalised = walletAddress.toLowerCase();

  // 1. Look up stored nonce
  const stored = nonceStore.get(normalised);
  if (!stored) {
    throw new AppError('Nonce not found. Please request a new nonce.', 401, 'NONCE_NOT_FOUND');
  }
  if (stored.nonce !== nonce) {
    throw new AppError('Invalid nonce.', 401, 'INVALID_NONCE');
  }
  if (Date.now() > stored.expiresAt) {
    nonceStore.delete(normalised);
    throw new AppError('Nonce expired. Please request a new nonce.', 401, 'NONCE_EXPIRED');
  }

  // 2. Recover signer from signature
  const message = buildSignMessage(normalised, nonce);
  let recoveredAddress;
  try {
    recoveredAddress = ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    throw new AppError('Invalid signature format.', 401, 'INVALID_SIGNATURE');
  }

  if (recoveredAddress !== normalised) {
    throw new AppError('Signature does not match wallet address.', 401, 'SIGNATURE_MISMATCH');
  }

  // 3. Invalidate nonce (one-time use)
  nonceStore.delete(normalised);

  // 4. Upsert user in DB
  const { rows } = await query(
    `INSERT INTO users (wallet_address, last_login_at, is_active)
     VALUES ($1, NOW(), true)
     ON CONFLICT (wallet_address) DO UPDATE
       SET last_login_at = NOW(), is_active = true
     RETURNING id, wallet_address, role, created_at`,
    [normalised]
  );

  const user = rows[0];

  // 5. Issue JWT
  const token = jwt.sign(
    { userId: user.id, wallet: user.wallet_address, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  logger.info(`User authenticated: ${normalised} (${user.role})`);

  res.json({
    success: true,
    data: {
      token,
      user: {
        id: user.id,
        walletAddress: user.wallet_address,
        role: user.role,
        createdAt: user.created_at,
      },
    },
  });
}

/**
 * GET /auth/me  – returns current user profile.
 */
async function getMe(req, res) {
  res.json({ success: true, data: { user: req.user } });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSignMessage(walletAddress, nonce) {
  return [
    'Welcome to TrustChain!',
    '',
    'Sign this message to authenticate your wallet.',
    'This request will not trigger a blockchain transaction.',
    '',
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Issued at: ${new Date().toISOString()}`,
  ].join('\n');
}

module.exports = { getNonce, verifySignature, getMe };
