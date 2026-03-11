const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const DonationABI = require('../../contracts/abis/DonationContract.json');
const CertificateABI = require('../../contracts/abis/CertificateContract.json');

class BlockchainService {
  constructor() {
    this.provider = null;
    this.signer = null;
    this.donationContract = null;
    this.certificateContract = null;
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;

    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) throw new Error('RPC_URL not configured');

    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    if (process.env.PRIVATE_KEY) {
      this.signer = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
      logger.info(`Blockchain signer: ${this.signer.address}`);
    }

    if (process.env.DONATION_CONTRACT_ADDRESS) {
      this.donationContract = new ethers.Contract(
        process.env.DONATION_CONTRACT_ADDRESS,
        DonationABI,
        this.signer || this.provider
      );
    }

    if (process.env.CERTIFICATE_CONTRACT_ADDRESS) {
      this.certificateContract = new ethers.Contract(
        process.env.CERTIFICATE_CONTRACT_ADDRESS,
        CertificateABI,
        this.signer || this.provider
      );
    }

    this._initialized = true;
    logger.info(`✅ Blockchain service connected to chain ${process.env.CHAIN_ID}`);
  }

  _ensureInit() {
    if (!this._initialized) throw new Error('BlockchainService not initialized');
  }

  // ── Donation Contract Methods ───────────────────────────────────────────────

  /**
   * Call donate() on the smart contract.
   * The actual ETH is sent from the user's wallet via frontend;
   * this records the server-side metadata call.
   */
  async donate(projectId, donorAddress, amount) {
    this._ensureInit();
    const contract = this.donationContract;

    const tx = await contract.donate(projectId, donorAddress, {
      value: ethers.parseEther(amount.toString()),
    });
    const receipt = await tx.wait();
    logger.info(`donate() tx confirmed: ${receipt.hash}`);
    return receipt;
  }

  /**
   * Allocate funds to a vendor wallet.
   */
  async allocateFunds(projectId, vendorAddress, amount) {
    this._ensureInit();
    const tx = await this.donationContract.allocateFunds(
      projectId,
      vendorAddress,
      ethers.parseEther(amount.toString())
    );
    const receipt = await tx.wait();
    logger.info(`allocateFunds() tx confirmed: ${receipt.hash}`);
    return receipt;
  }

  /**
   * Release milestone funds after verification.
   */
  async releaseMilestoneFunds(projectId, milestoneId, vendorAddress) {
    this._ensureInit();
    const tx = await this.donationContract.releaseMilestoneFunds(
      projectId,
      milestoneId,
      vendorAddress
    );
    const receipt = await tx.wait();
    logger.info(`releaseMilestoneFunds() tx confirmed: ${receipt.hash}`);
    return receipt;
  }

  // ── Certificate Contract Methods ────────────────────────────────────────────

  /**
   * Mint a certificate NFT on-chain.
   */
  async issueCertificate(recipientAddress, metadataUri, certificateId) {
    this._ensureInit();
    const tx = await this.certificateContract.issueCertificate(
      recipientAddress,
      metadataUri,
      certificateId
    );
    const receipt = await tx.wait();
    logger.info(`issueCertificate() tx confirmed: ${receipt.hash}`);
    return receipt;
  }

  /**
   * Verify a certificate on-chain (read-only).
   */
  async verifyCertificate(certificateId) {
    this._ensureInit();
    const result = await this.certificateContract.verifyCertificate(certificateId);
    return result;
  }

  /**
   * Revoke a certificate on-chain.
   */
  async revokeCertificate(certificateId, reason) {
    this._ensureInit();
    const tx = await this.certificateContract.revokeCertificate(
      certificateId,
      ethers.encodeBytes32String(reason.slice(0, 31))
    );
    const receipt = await tx.wait();
    logger.info(`revokeCertificate() tx confirmed: ${receipt.hash}`);
    return receipt;
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  /**
   * Get current gas price estimate.
   */
  async getGasPrice() {
    this._ensureInit();
    const feeData = await this.provider.getFeeData();
    return {
      gasPrice: feeData.gasPrice?.toString(),
      maxFeePerGas: feeData.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
    };
  }

  /**
   * Get block number.
   */
  async getBlockNumber() {
    this._ensureInit();
    return this.provider.getBlockNumber();
  }

  // ── Event Listeners ─────────────────────────────────────────────────────────

  async startEventListeners() {
    try {
      await this.init();
    } catch (err) {
      logger.warn('Blockchain not available; event listeners skipped:', err.message);
      return;
    }

    if (this.donationContract) {
      this.donationContract.on('DonationReceived', async (projectId, donor, amount, txHash, event) => {
        logger.info(`Event: DonationReceived – project ${projectId}, donor ${donor}`);
        try {
          await query(
            `INSERT INTO transactions (tx_hash, event_type, project_id, from_address, amount, block_number, created_at)
             VALUES ($1, 'DonationReceived', $2, $3, $4, $5, NOW())
             ON CONFLICT (tx_hash) DO NOTHING`,
            [event.log.transactionHash, projectId, donor, ethers.formatEther(amount), event.log.blockNumber]
          );
        } catch (dbErr) {
          logger.error('DB write failed for DonationReceived:', dbErr.message);
        }
      });

      this.donationContract.on('FundsReleased', async (projectId, milestoneId, vendor, amount, event) => {
        logger.info(`Event: FundsReleased – project ${projectId}, milestone ${milestoneId}`);
        try {
          await query(
            `INSERT INTO transactions (tx_hash, event_type, project_id, to_address, amount, block_number, created_at)
             VALUES ($1, 'FundsReleased', $2, $3, $4, $5, NOW())
             ON CONFLICT (tx_hash) DO NOTHING`,
            [event.log.transactionHash, projectId, vendor, ethers.formatEther(amount), event.log.blockNumber]
          );
          await query(
            `UPDATE milestones SET status = 'released', released_at = NOW() WHERE id = $1`,
            [milestoneId]
          );
        } catch (dbErr) {
          logger.error('DB write failed for FundsReleased:', dbErr.message);
        }
      });
    }

    if (this.certificateContract) {
      this.certificateContract.on('CertificateIssued', async (certificateId, recipient, tokenId, event) => {
        logger.info(`Event: CertificateIssued – cert ${certificateId}, recipient ${recipient}`);
        try {
          await query(
            `UPDATE certificates SET token_id = $1, tx_hash = $2, status = 'issued', issued_at = NOW() WHERE id = $3`,
            [tokenId.toString(), event.log.transactionHash, certificateId]
          );
        } catch (dbErr) {
          logger.error('DB write failed for CertificateIssued:', dbErr.message);
        }
      });

      this.certificateContract.on('CertificateRevoked', async (certificateId, event) => {
        logger.info(`Event: CertificateRevoked – cert ${certificateId}`);
        try {
          await query(
            `UPDATE certificates SET status = 'revoked', revoked_at = NOW(), revoke_tx_hash = $1 WHERE id = $2`,
            [event.log.transactionHash, certificateId]
          );
        } catch (dbErr) {
          logger.error('DB write failed for CertificateRevoked:', dbErr.message);
        }
      });
    }

    logger.info('📡 Blockchain event listeners attached');
  }
}

module.exports = new BlockchainService();
