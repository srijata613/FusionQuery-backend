const { z } = require('zod');

// ── Shared primitives ─────────────────────────────────────────────────────────
const walletAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

const txHash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transaction hash');

const uuidSchema = z.string().uuid('Invalid UUID');

// ── Auth ──────────────────────────────────────────────────────────────────────
const nonceQuerySchema = z.object({
  walletAddress: walletAddress,
});

const verifySchema = z.object({
  walletAddress: walletAddress,
  signature: z.string().min(132, 'Signature too short').max(134, 'Signature too long'),
  nonce: z.string().uuid('Invalid nonce'),
});

// ── Donations ─────────────────────────────────────────────────────────────────
const createProjectSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  targetAmount: z.number().positive('Target must be positive'),
  currency: z.enum(['ETH', 'MATIC', 'USDC']).default('MATIC'),
  category: z.enum(['education', 'health', 'environment', 'poverty', 'disaster', 'other']),
  beneficiaryAddress: walletAddress,
  endDate: z.string().datetime('Invalid date').optional(),
  milestones: z.array(z.object({
    title: z.string().min(3).max(200),
    description: z.string().min(10).max(1000),
    targetAmount: z.number().positive(),
    dueDate: z.string().datetime().optional(),
  })).min(1, 'At least one milestone required').max(10),
});

const donateSchema = z.object({
  projectId: uuidSchema,
  amount: z.number().positive('Donation must be positive'),
  txHash: txHash,
  donorWallet: walletAddress,
  message: z.string().max(500).optional(),
  anonymous: z.boolean().default(false),
});

const milestoneSchema = z.object({
  projectId: uuidSchema,
  milestoneId: uuidSchema,
  proofIpfsHash: z.string().min(10, 'IPFS hash required'),
  description: z.string().min(10).max(2000),
});

const releaseFundsSchema = z.object({
  projectId: uuidSchema,
  milestoneId: uuidSchema,
  vendorAddress: walletAddress,
  amount: z.number().positive(),
});

// ── Certificates ──────────────────────────────────────────────────────────────
const issueCertificateSchema = z.object({
  recipientWallet: walletAddress,
  recipientName: z.string().min(2).max(200),
  courseTitle: z.string().min(3).max(300),
  institutionName: z.string().min(3).max(300),
  grade: z.string().max(20).optional(),
  completionDate: z.string().datetime(),
  skills: z.array(z.string().max(100)).max(20).default([]),
  expiryDate: z.string().datetime().optional(),
  metadata: z.record(z.string()).optional(),
});

const revokeCertificateSchema = z.object({
  certificateId: uuidSchema,
  reason: z.string().min(10).max(500),
});

// ── Analytics queries ─────────────────────────────────────────────────────────
const analyticsQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  currency: z.enum(['ETH', 'MATIC', 'USDC', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

module.exports = {
  walletAddress,
  txHash,
  uuidSchema,
  nonceQuerySchema,
  verifySchema,
  createProjectSchema,
  donateSchema,
  milestoneSchema,
  releaseFundsSchema,
  issueCertificateSchema,
  revokeCertificateSchema,
  analyticsQuerySchema,
};
