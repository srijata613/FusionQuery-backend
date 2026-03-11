const { v4: uuidv4 } = require('uuid');
const { query, getClient } = require('../config/database');
const blockchainService = require('../services/blockchainService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// ── POST /donations/project ───────────────────────────────────────────────────
async function createProject(req, res) {
  const {
    title, description, targetAmount, currency,
    category, beneficiaryAddress, endDate, milestones,
  } = req.body;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const projectId = uuidv4();
    const { rows: [project] } = await client.query(
      `INSERT INTO projects
         (id, charity_id, title, description, target_amount, currency,
          category, beneficiary_address, end_date, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',NOW())
       RETURNING *`,
      [projectId, req.user.id, title, description, targetAmount,
       currency, category, beneficiaryAddress.toLowerCase(), endDate || null]
    );

    // Insert milestones
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      await client.query(
        `INSERT INTO milestones
           (id, project_id, title, description, target_amount, due_date, order_index, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
        [uuidv4(), projectId, m.title, m.description,
         m.targetAmount, m.dueDate || null, i + 1]
      );
    }

    await client.query('COMMIT');

    logger.info(`Project created: ${projectId} by ${req.user.wallet_address}`);
    res.status(201).json({ success: true, data: { project } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── POST /donations/donate ────────────────────────────────────────────────────
async function recordDonation(req, res) {
  const { projectId, amount, txHash, donorWallet, message, anonymous } = req.body;

  // Verify project exists and is active
  const { rows: [project] } = await query(
    'SELECT id, status, target_amount, raised_amount FROM projects WHERE id = $1',
    [projectId]
  );
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
  if (project.status !== 'active') throw new AppError('Project is not accepting donations', 400, 'PROJECT_INACTIVE');

  // Verify tx hash not already recorded
  const { rows: existing } = await query(
    'SELECT id FROM donations WHERE tx_hash = $1', [txHash]
  );
  if (existing.length) throw new AppError('Transaction already recorded', 409, 'DUPLICATE_TX');

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const donationId = uuidv4();
    const { rows: [donation] } = await client.query(
      `INSERT INTO donations
         (id, project_id, donor_id, donor_wallet, amount, tx_hash, message, anonymous, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',NOW())
       RETURNING *`,
      [donationId, projectId, req.user.id, donorWallet.toLowerCase(),
       amount, txHash, message || null, anonymous]
    );

    // Update project raised amount
    await client.query(
      `UPDATE projects SET raised_amount = raised_amount + $1, updated_at = NOW() WHERE id = $2`,
      [amount, projectId]
    );

    // Record transaction
    await client.query(
      `INSERT INTO transactions (id, tx_hash, event_type, project_id, from_address, amount, created_at)
       VALUES ($1,$2,'donation',$3,$4,$5,NOW())`,
      [uuidv4(), txHash, projectId, donorWallet.toLowerCase(), amount]
    );

    await client.query('COMMIT');

    logger.info(`Donation recorded: ${donationId} – ${amount} from ${donorWallet}`);
    res.status(201).json({ success: true, data: { donation } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── GET /donations/project/:id ────────────────────────────────────────────────
async function getProject(req, res) {
  const { id } = req.params;

  const { rows: [project] } = await query(
    `SELECT p.*, u.wallet_address AS charity_wallet,
            COUNT(d.id) AS donation_count
     FROM projects p
     LEFT JOIN users u ON u.id = p.charity_id
     LEFT JOIN donations d ON d.project_id = p.id
     WHERE p.id = $1
     GROUP BY p.id, u.wallet_address`,
    [id]
  );
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');

  const { rows: milestones } = await query(
    'SELECT * FROM milestones WHERE project_id = $1 ORDER BY order_index',
    [id]
  );

  res.json({ success: true, data: { project, milestones } });
}

// ── GET /donations/transactions ───────────────────────────────────────────────
async function getTransactions(req, res) {
  const { projectId, limit = 50, offset = 0 } = req.query;

  let sql = `SELECT t.*, p.title AS project_title
             FROM transactions t
             LEFT JOIN projects p ON p.id = t.project_id
             WHERE 1=1`;
  const params = [];

  if (projectId) {
    params.push(projectId);
    sql += ` AND t.project_id = $${params.length}`;
  }

  params.push(parseInt(limit), parseInt(offset));
  sql += ` ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const { rows } = await query(sql, params);
  res.json({ success: true, data: { transactions: rows, count: rows.length } });
}

// ── POST /donations/milestone ─────────────────────────────────────────────────
async function submitMilestoneProof(req, res) {
  const { projectId, milestoneId, proofIpfsHash, description } = req.body;

  const { rows: [milestone] } = await query(
    'SELECT * FROM milestones WHERE id = $1 AND project_id = $2',
    [milestoneId, projectId]
  );
  if (!milestone) throw new AppError('Milestone not found', 404, 'MILESTONE_NOT_FOUND');
  if (milestone.status === 'released') throw new AppError('Milestone already released', 400, 'ALREADY_RELEASED');

  await query(
    `UPDATE milestones
     SET status = 'proof_submitted', proof_ipfs_hash = $1, proof_description = $2, updated_at = NOW()
     WHERE id = $3`,
    [proofIpfsHash, description, milestoneId]
  );

  logger.info(`Milestone proof submitted: ${milestoneId}`);
  res.json({ success: true, data: { milestoneId, proofIpfsHash, status: 'proof_submitted' } });
}

// ── POST /donations/release ───────────────────────────────────────────────────
async function releaseFunds(req, res) {
  const { projectId, milestoneId, vendorAddress, amount } = req.body;

  const { rows: [milestone] } = await query(
    'SELECT * FROM milestones WHERE id = $1 AND project_id = $2',
    [milestoneId, projectId]
  );
  if (!milestone) throw new AppError('Milestone not found', 404, 'MILESTONE_NOT_FOUND');
  if (milestone.status !== 'proof_submitted') {
    throw new AppError('Milestone proof must be submitted before releasing funds', 400, 'INVALID_MILESTONE_STATE');
  }

  // Call smart contract
  let receipt;
  try {
    receipt = await blockchainService.releaseMilestoneFunds(projectId, milestoneId, vendorAddress);
  } catch (err) {
    logger.error('releaseMilestoneFunds smart contract call failed:', err.message);
    throw new AppError('Blockchain transaction failed: ' + err.message, 502, 'BLOCKCHAIN_ERROR');
  }

  // Update DB
  await query(
    `UPDATE milestones
     SET status = 'released', released_at = NOW(), release_tx_hash = $1
     WHERE id = $2`,
    [receipt.hash, milestoneId]
  );

  await query(
    `INSERT INTO transactions (id, tx_hash, event_type, project_id, to_address, amount, created_at)
     VALUES ($1,$2,'release',$3,$4,$5,NOW())`,
    [require('uuid').v4(), receipt.hash, projectId, vendorAddress.toLowerCase(), amount]
  );

  logger.info(`Funds released: milestone ${milestoneId}, tx ${receipt.hash}`);
  res.json({
    success: true,
    data: { milestoneId, txHash: receipt.hash, vendorAddress, amount, status: 'released' },
  });
}

module.exports = {
  createProject, recordDonation, getProject,
  getTransactions, submitMilestoneProof, releaseFunds,
};
