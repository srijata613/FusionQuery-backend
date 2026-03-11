const axios = require('axios');
const FormData = require('form-data');
const logger = require('../utils/logger');

const PINATA_BASE = 'https://api.pinata.cloud';

class IPFSService {
  constructor() {
    this.headers = {
      pinata_api_key: process.env.PINATA_API_KEY,
      pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY,
    };
    this.jwtHeaders = {
      Authorization: `Bearer ${process.env.PINATA_JWT}`,
    };
    this.gateway = process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs';
  }

  /**
   * Upload a Buffer / ReadStream as a file to IPFS via Pinata.
   * Returns the IPFS hash (CID).
   */
  async uploadFile(buffer, filename, mimeType = 'application/octet-stream') {
    const form = new FormData();
    form.append('file', buffer, {
      filename,
      contentType: mimeType,
    });

    form.append('pinataMetadata', JSON.stringify({ name: filename }));
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

    const response = await axios.post(`${PINATA_BASE}/pinning/pinFileToIPFS`, form, {
      headers: { ...form.getHeaders(), ...this.headers },
      maxBodyLength: Infinity,
    });

    const ipfsHash = response.data.IpfsHash;
    logger.info(`IPFS file uploaded: ${ipfsHash}`);
    return {
      ipfsHash,
      url: `${this.gateway}/${ipfsHash}`,
      size: response.data.PinSize,
    };
  }

  /**
   * Upload a JSON object as metadata to IPFS.
   */
  async uploadJSON(jsonObject, name = 'metadata') {
    const response = await axios.post(
      `${PINATA_BASE}/pinning/pinJSONToIPFS`,
      {
        pinataContent: jsonObject,
        pinataMetadata: { name },
        pinataOptions: { cidVersion: 1 },
      },
      { headers: { ...this.headers, 'Content-Type': 'application/json' } }
    );

    const ipfsHash = response.data.IpfsHash;
    logger.info(`IPFS JSON uploaded: ${ipfsHash}`);
    return {
      ipfsHash,
      url: `${this.gateway}/${ipfsHash}`,
      size: response.data.PinSize,
    };
  }

  /**
   * Build and upload ERC-721 compatible certificate metadata.
   */
  async uploadCertificateMetadata({
    certificateId,
    recipientName,
    recipientWallet,
    courseTitle,
    institutionName,
    grade,
    completionDate,
    skills,
    expiryDate,
    imageHash,
    extraMetadata = {},
  }) {
    const metadata = {
      name: `${courseTitle} – ${recipientName}`,
      description: `Certificate issued by ${institutionName} to ${recipientName} for completing ${courseTitle}`,
      image: imageHash ? `ipfs://${imageHash}` : `${this.gateway}/QmDefaultCertImage`,
      external_url: `${process.env.FRONTEND_URL}/certificate/${certificateId}`,
      attributes: [
        { trait_type: 'Recipient', value: recipientName },
        { trait_type: 'Recipient Wallet', value: recipientWallet },
        { trait_type: 'Course', value: courseTitle },
        { trait_type: 'Institution', value: institutionName },
        { trait_type: 'Completion Date', value: completionDate },
        ...(grade ? [{ trait_type: 'Grade', value: grade }] : []),
        ...(expiryDate ? [{ trait_type: 'Expiry Date', value: expiryDate }] : []),
        ...skills.map((s) => ({ trait_type: 'Skill', value: s })),
      ],
      trustchain: {
        certificateId,
        issuedAt: new Date().toISOString(),
        blockchain: `Chain ID ${process.env.CHAIN_ID}`,
        contractAddress: process.env.CERTIFICATE_CONTRACT_ADDRESS,
        ...extraMetadata,
      },
    };

    return this.uploadJSON(metadata, `cert-${certificateId}`);
  }

  /**
   * Retrieve content from IPFS by hash.
   */
  async getContent(ipfsHash) {
    const url = `${this.gateway}/${ipfsHash}`;
    const response = await axios.get(url, { timeout: 10000 });
    return response.data;
  }

  /**
   * Unpin / remove a pinned file (e.g., on revocation).
   */
  async unpin(ipfsHash) {
    try {
      await axios.delete(`${PINATA_BASE}/pinning/unpin/${ipfsHash}`, {
        headers: this.headers,
      });
      logger.info(`IPFS unpinned: ${ipfsHash}`);
      return true;
    } catch (err) {
      logger.warn(`IPFS unpin failed for ${ipfsHash}:`, err.message);
      return false;
    }
  }

  /**
   * Test Pinata authentication.
   */
  async testAuth() {
    const resp = await axios.get(`${PINATA_BASE}/data/testAuthentication`, {
      headers: this.headers,
    });
    return resp.data;
  }
}

module.exports = new IPFSService();
