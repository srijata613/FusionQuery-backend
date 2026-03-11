# TrustChain Backend

> Blockchain-based transparent donation tracking & decentralized skill certificate verification

Built with **Node.js + Express.js**, **ethers.js** (Ethereum/Polygon), **IPFS via Pinata**, and **PostgreSQL**.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Nginx (TLS Termination)                     │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────────┐
│                     Express.js API Server                           │
│  ┌──────────┐ ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌────────┐ │
│  │   Auth   │ │ Donations │ │   Certs   │ │  IPFS    │ │Analyt. │ │
│  └────┬─────┘ └─────┬─────┘ └─────┬─────┘ └────┬─────┘ └───┬────┘ │
│       │              │             │             │            │      │
│  ┌────▼──────────────▼─────────────▼─────────────▼────────────▼───┐ │
│  │          Service Layer (Blockchain + IPFS + DB)                │ │
│  └────────────┬──────────────────────────────────────────────────┘ │
└───────────────┼─────────────────────────────────────────────────────┘
                │
       ┌────────┼──────────┐
       │        │          │
  ┌────▼──┐ ┌──▼──────┐ ┌─▼──────────┐
  │  PG   │ │ Polygon │ │  Pinata    │
  │  DB   │ │   RPC   │ │  IPFS      │
  └───────┘ └─────────┘ └────────────┘
```

---

## Quick Start

### Prerequisites
- Node.js 20+
- Docker & Docker Compose
- A Polygon Mumbai (or mainnet) RPC URL
- Pinata account for IPFS
- Deployed smart contracts

### 1. Clone & install
```bash
git clone https://github.com/your-org/trustchain-backend
cd trustchain-backend
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your RPC_URL, PRIVATE_KEY, contract addresses, Pinata keys, etc.
```

### 3. Run with Docker Compose
```bash
docker-compose up -d
# Migrations run automatically via the migrate service
```

### 4. Run locally (development)
```bash
# Start PostgreSQL locally, then:
node scripts/migrate.js      # run migrations
npm run dev                  # start with nodemon
```

---

## API Reference

### Authentication
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET  | `/api/v1/auth/nonce` | — | Get sign nonce for wallet |
| POST | `/api/v1/auth/verify` | — | Verify signature → JWT |
| GET  | `/api/v1/auth/me` | JWT | Current user profile |

**MetaMask Login Flow:**
```
1. GET /auth/nonce?walletAddress=0x...
2. User signs the returned message in MetaMask
3. POST /auth/verify { walletAddress, signature, nonce }
4. Receive { token: "eyJ..." }
5. Include header: Authorization: Bearer <token>
```

### Donations
| Method | Endpoint | Auth | Role |
|--------|----------|------|------|
| POST | `/api/v1/donations/project` | JWT | charity, admin |
| POST | `/api/v1/donations/donate` | JWT | any |
| GET  | `/api/v1/donations/project/:id` | — | public |
| GET  | `/api/v1/donations/transactions` | JWT | any |
| POST | `/api/v1/donations/milestone` | JWT | charity, admin |
| POST | `/api/v1/donations/release` | JWT | charity, admin |

### Certificates
| Method | Endpoint | Auth | Role |
|--------|----------|------|------|
| POST | `/api/v1/certificate/issue` | JWT | institution, admin |
| GET  | `/api/v1/certificate/:id` | — | public |
| POST | `/api/v1/certificate/revoke` | JWT | institution, admin |
| GET  | `/api/v1/certificate/verify/:id` | — | public |

### Public Verification (QR Scan)
| Method | Endpoint | Auth |
|--------|----------|------|
| GET  | `/api/v1/verify/:certificate_id` | — |

### IPFS Storage
| Method | Endpoint | Auth |
|--------|----------|------|
| POST | `/api/v1/ipfs/upload` | JWT |
| POST | `/api/v1/ipfs/upload-json` | JWT |

### Analytics
| Method | Endpoint | Auth |
|--------|----------|------|
| GET  | `/api/v1/analytics/total-donations` | — |
| GET  | `/api/v1/analytics/projects` | — |
| GET  | `/api/v1/analytics/fund-flow` | — |

---

## User Roles
| Role | Capabilities |
|------|-------------|
| `donor` | Donate to projects, view transactions |
| `charity` | Create projects, submit milestones, release funds |
| `institution` | Issue & revoke certificates |
| `admin` | All capabilities |

---

## Smart Contract Functions Called

### Donation Contract
```
donate(projectId, donorAddress) payable
allocateFunds(projectId, vendorAddress, amount)
releaseMilestoneFunds(projectId, milestoneId, vendor)
```

### Certificate Contract (ERC-721)
```
issueCertificate(recipient, metadataUri, certificateId) → tokenId
verifyCertificate(certificateId) → (isValid, recipient, metadataUri, issuedAt, revoked)
revokeCertificate(certificateId, reason)
```

### Events Listened
```
DonationReceived(projectId, donor, amount, txHash)
FundsReleased(projectId, milestoneId, vendor, amount)
CertificateIssued(certificateId, recipient, tokenId)
CertificateRevoked(certificateId)
```

---

## Database Schema

```
users          – wallet_address, role, is_active
projects       – title, target_amount, raised_amount, status, milestones[]
milestones     – project_id, proof_ipfs_hash, status, release_tx_hash
donations      – project_id, donor_wallet, tx_hash, amount, anonymous
certificates   – recipient_wallet, course_title, ipfs_hash, token_id, status
transactions   – tx_hash, event_type, amount, block_number
```

---

## Security
- **JWT** authentication with configurable expiry
- **Role-based access control** on all mutation endpoints
- **Rate limiting**: 100 req/15min globally, 20 req/15min on auth
- **Helmet.js** security headers
- **Zod** schema validation on all inputs
- **Signature verification** via ethers.js `verifyMessage`
- **One-time nonces** with 5-minute TTL
- Non-root Docker container

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | ✅ |
| `JWT_SECRET` | Secret for signing JWTs | ✅ |
| `RPC_URL` | Ethereum/Polygon RPC endpoint | ✅ |
| `PRIVATE_KEY` | Server wallet private key | ✅ |
| `DONATION_CONTRACT_ADDRESS` | Deployed donation contract | ✅ |
| `CERTIFICATE_CONTRACT_ADDRESS` | Deployed certificate contract | ✅ |
| `PINATA_API_KEY` | Pinata IPFS API key | ✅ |
| `PINATA_SECRET_API_KEY` | Pinata secret | ✅ |
| `CHAIN_ID` | Blockchain network ID (e.g. 80001) | ✅ |
| `FRONTEND_URL` | Frontend origin for CORS + QR links | ✅ |

---

## Running Tests
```bash
npm test
# or
npm test -- --coverage
```
