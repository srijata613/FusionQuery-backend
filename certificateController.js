const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { query } = require('../config/database');
const blockchainService = require('../services/blockchainService');
const ipfsService = require('../services/ipfsService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// ── POST /certificate/issue ───────────────────────────────────────────────────
async function issueCertificate(req, res) {
  const {
    recipientWallet, recipientName, courseTitle, institutionName,
    grade, completionDate, skills, expiryDate, metadata: extraMetadata,
  } = req.body;

  const certificateId = uuidv4();

  // 1. Upload metadata to IPFS
  let ipfsResult;
  try {
    ipfsResult = await ipfsService.uploadCertificateMetadata({
      certificateId,
      recipientName,
      recipientWallet,
      courseTitle,
      institutionName,
      grade,
      completionDate,
      skills: skills || [],
      expiryDate,
      extraMetadata,
    });
  } catch (err) {
    logger.error('IPFS upload failed:', err.message);
    throw new AppError('Failed to upload certificate to IPFS: ' + err.message, 502, 'IPFS_ERROR');
  }

  // 2. Insert pending record in DB
  await query(
    `INSERT INTO certificates
       (id, issuer_id, recipient_wallet, recipient_name, course_title, institution_name,
        grade, completion_date, expiry_date, skills, ipfs_hash, metadata_url, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',NOW())`,
    [
      certificateId, req.user.id, recipientWallet.toLowerCase(), recipientName,
      courseTitle, institutionName, grade || null, completionDate,
      expiryDate || null, JSON.stringify(skills || []),
      ipfsResult.ipfsHash, ipfsResult.url,
    ]
  );

  // 3. Call smart contract to mint certificate
  let receipt;
  try {
    const metadataUri = `ipfs://${ipfsResult.ipfsHash}`;
    receipt = await blockchainService.issueCertificate(
      recipientWallet,
      metadataUri,
      certificateId
    );
  } catch (err) {
    logger.error('issueCertificate smart contract call failed:', err.message);
    // Mark as failed but keep the IPFS hash
    await query(
      `UPDATE certificates SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [certificateId]
    );
    throw new AppError('Blockchain minting failed: ' + err.message, 502, 'BLOCKCHAIN_ERROR');
  }

  // 4. Update DB with on-chain data
  await query(
    `UPDATE certificates
     SET status = 'issued', tx_hash = $1, issued_at = NOW(), updated_at = NOW()
     WHERE id = $2`,
    [receipt.hash, certificateId]
  );

  // 5. Generate QR code
  const verifyUrl = `${process.env.FRONTEND_URL}/verify/${certificateId}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl);

  logger.info(`Certificate issued: ${certificateId} for ${recipientWallet}`);
  res.status(201).json({
    success: true,
    data: {
      certificateId,
      txHash: receipt.hash,
      ipfsHash: ipfsResult.ipfsHash,
      metadataUrl: ipfsResult.url,
      verifyUrl,
      qrCode: qrDataUrl,
    },
  });
}

// ── GET /certificate/:id ──────────────────────────────────────────────────────
async function getCertificate(req, res) {
  const { id } = req.params;

  const { rows: [cert] } = await query(
    `SELECT c.*, u.wallet_address AS issuer_wallet
     FROM certificates c
     LEFT JOIN users u ON u.id = c.issuer_id
     WHERE c.id = $1`,
    [id]
  );
  if (!cert) throw new AppError('Certificate not found', 404, 'CERT_NOT_FOUND');

  const verifyUrl = `${process.env.FRONTEND_URL}/verify/${id}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl);

  res.json({
    success: true,
    data: { certificate: cert, qrCode: qrDataUrl, verifyUrl },
  });
}

// ── POST /certificate/revoke ──────────────────────────────────────────────────
async function revokeCertificate(req, res) {
  const { certificateId, reason } = req.body;

  const { rows: [cert] } = await query(
    'SELECT * FROM certificates WHERE id = $1',
    [certificateId]
  );
  if (!cert) throw new AppError('Certificate not found', 404, 'CERT_NOT_FOUND');
  if (cert.status === 'revoked') throw new AppError('Certificate already revoked', 400, 'ALREADY_REVOKED');
  if (cert.status !== 'issued') throw new AppError('Certificate has not been issued yet', 400, 'NOT_ISSUED');

  // Only the issuing institution or admin can revoke
  if (cert.issuer_id !== req.user.id && req.user.role !== 'admin') {
    throw new AppError('Only the issuing institution can revoke this certificate', 403, 'FORBIDDEN');
  }

  // Call smart contract
  let receipt;
  try {
    receipt = await blockchainService.revokeCertificate(certificateId, reason);
  } catch (err) {
    throw new AppError('Blockchain revocation failed: ' + err.message, 502, 'BLOCKCHAIN_ERROR');
  }

  await query(
    `UPDATE certificates
     SET status = 'revoked', revoked_at = NOW(), revoke_reason = $1,
         revoke_tx_hash = $2, updated_at = NOW()
     WHERE id = $3`,
    [reason, receipt.hash, certificateId]
  );

  logger.info(`Certificate revoked: ${certificateId}`);
  res.json({
    success: true,
    data: { certificateId, txHash: receipt.hash, status: 'revoked' },
  });
}

// ── GET /certificate/verify/:id ───────────────────────────────────────────────
async function verifyCertificate(req, res) {
  const { id } = req.params;

  // Check DB first
  const { rows: [cert] } = await query(
    'SELECT * FROM certificates WHERE id = $1',
    [id]
  );
  if (!cert) throw new AppError('Certificate not found', 404, 'CERT_NOT_FOUND');

  // Verify on blockchain (ground truth)
  let onChainData = null;
  let blockchainVerified = false;

  try {
    onChainData = await blockchainService.verifyCertificate(id);
    blockchainVerified = true;
  } catch (err) {
    logger.warn(`On-chain verification failed for ${id}:`, err.message);
  }

  const isValid = cert.status === 'issued' && !cert.revoked_at;

  res.json({
    success: true,
    data: {
      valid: isValid,
      status: cert.status,
      blockchainVerified,
      certificate: {
        id: cert.id,
        recipientName: cert.recipient_name,
        recipientWallet: cert.recipient_wallet,
        courseTitle: cert.course_title,
        institutionName: cert.institution_name,
        grade: cert.grade,
        completionDate: cert.completion_date,
        expiryDate: cert.expiry_date,
        skills: cert.skills,
        issuedAt: cert.issued_at,
        revokedAt: cert.revoked_at,
        ipfsHash: cert.ipfs_hash,
        metadataUrl: cert.metadata_url,
        txHash: cert.tx_hash,
      },
      onChainData,
    },
  });
}

module.exports = { issueCertificate, getCertificate, revokeCertificate, verifyCertificate };
