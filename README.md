# FixMate Server

FixMate Server is the independent Express/MongoDB backend for FixMate, a role-based smart-device and home-appliance repair marketplace (Assignment 9, Category 006). It exposes authenticated JSON APIs for services, bookings, payments, profile/admin operations, and image uploads, while enforcing server-side authorization, ownership, validation, and Stripe webhook verification.

## Live API URL

- Live API URL: `PENDING OWNER DEPLOYMENT` (no live deployment is claimed by this repository)
- Live Client URL: `PENDING OWNER DEPLOYMENT` (owner-managed; see Client README)

## Repository Links

- Client repository: https://github.com/Fahim-mukim/fixmate-client
- Server repository: https://github.com/Fahim-mukim/fxmate-server-

## API Responsibilities and Implemented Endpoint Groups

The server mounts these endpoint groups in `src/app.js`:

- `GET /api/health` - process health check.
- `GET /api/ready` - database readiness check.
- `/api/auth` - authenticated identity/role resolution endpoints used by server-side auth flows.
- `/api/profile` - authenticated user profile read/update operations.
- `/api/admin/users` - admin-only user listing and role-management operations.
- `/api/services` - public service listing/detail plus authenticated technician/admin service management/moderation routes as implemented in `src/services/routes.js`.
- `/api/bookings` - authenticated booking creation, role-scoped listing/detail/status transitions, and admin read-only listing filters.
- `/api/uploads` - authenticated server-side ImgBB upload proxy (mounted before the global 1 MB JSON parser with its own explicit limit).
- `/api/payments/webhook` - Stripe webhook endpoint (mounted before the global JSON parser so raw body signature verification is possible).
- `/api/payments` - authenticated Stripe Checkout session creation and payment-read endpoints.

For exact request/response behavior, inspect route modules under `src/` and the focused tests under `test/`.

## Technology Stack

Based on `package.json` and implemented source:

- Node.js + Express 5
- MongoDB Node driver 7
- `jose` for Better Auth JWT/JWKS verification
- `stripe` for Checkout and webhook verification
- `cors`, `dotenv`
- Node built-in test runner (`node --test`)

## Installation and Local Development

```bash
cd fixmate-server
npm install
npm run dev
```

## Available Scripts

- `npm run dev` - start server with Node watch mode (`node --watch index.js`).
- `npm start` - start server (`node index.js`).
- `npm test` - run Node test suite (`node --test`).
- `npm run check` - syntax-check server entry/scripts/source modules.
- `npm run migrate:users` - legacy users-to-canonical-user migration script (explicit/manual; inspect script before use).
- `npm run seed:demo` - explicit, opt-in demo seed workflow (see Seed Data section).
- `npm run remediate:booking-final-amount` - guarded one-time maintenance script for correcting a single completed, unpaid booking `finalAmount`; dry-run by default, `--apply` required, strict preconditions, no production data changes during normal development/tests.

## Required Server Environment Variable Names

Configure these names in a local `.env` file (never commit real values). See `.env.example` for safe placeholders:

- `PORT` - HTTP port (default 5000).
- `MONGODB_URI` - MongoDB connection string for the target database.
- `CLIENT_ORIGIN` - allowed client origin(s) for CORS.
- `NODE_ENV` - set explicitly in production.
- `AUTH_JWT_ISSUER` - Better Auth JWT issuer expected by server verification.
- `AUTH_JWT_JWKS_URL` - Better Auth JWKS URL.
- `AUTH_JWT_AUDIENCE` - expected JWT audience.
- `AUTH_JWT_ALGORITHMS` - allowed JWT algorithms (default `EdDSA`).
- `IMGBB_API_KEY` - server-only ImgBB key; never expose as `NEXT_PUBLIC_*`.
- `STRIPE_SECRET_KEY` - server-only Stripe secret key (test mode for local/test use).
- `STRIPE_WEBHOOK_SECRET` - server-only Stripe webhook signing secret (CLI and Dashboard secrets differ by environment).

## MongoDB and Collection Architecture

- Application database default name: `fixmate` (configured in `src/config.js`).
- Canonical application user collection: `user` (Better Auth canonical collection; see `src/users/userModel.js`).
- Application data collections: `user`, `services`, `bookings`, `payments` (`src/services/serviceModel.js`).
- Better Auth internal collections (`session`, `account`, `verification`, `jwks`) are managed by Better Auth and are not treated as FixMate application data collections.
- Legacy `users` collection is migration backup context only, not the authoritative runtime user store.

## Better Auth JWT/JWKS Verification and Role Authorization

- The Client uses Better Auth; the Server does not trust client-supplied identity or role.
- Server verifies JWTs using JWKS and `jose` (`src/auth/jwtVerifier.js`, `src/auth/middleware.js`).
- After token verification, the server loads the authoritative canonical user from MongoDB and exposes it to handlers as `req.user`.
- Role checks and ownership checks are enforced server-side for protected routes (Customer, Technician, Admin).
- Admin provisioning is a deliberate owner-controlled/manual operation. Do not auto-create or overwrite Admin accounts through seed scripts.

## ImgBB Server-Side Upload Proxy

- Image uploads go through server-side routes (`src/uploads/uploadRoutes.js`, `src/uploads/imgBbClient.js`).
- `IMGBB_API_KEY` is server-only and must never be exposed in Client env vars, browser bundles, logs, or Git.
- Upload validation and size/type constraints are enforced by server code before proxying to ImgBB.

## Stripe Checkout and Webhook Architecture

- Stripe secret keys remain server-only (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`).
- Checkout session creation is server-side (`src/payments/checkoutService.js`, `src/payments/checkoutRoutes.js`).
- Webhook endpoint `/api/payments/webhook` uses raw body verification before JSON parsing for normal routes (`src/app.js`, `src/payments/webhookRoutes.js`).
- Webhook/payment processing is designed to be idempotent and ownership-safe through payment/booking repository checks.
- No live Stripe test-mode end-to-end verification is claimed in this README unless separately recorded with real evidence.

## Seed Data / Demo Database Workflow

The seed workflow is implemented by `scripts/seed-demo.js` and `src/seed/demoSeed.js`.

### Safety conditions

- Explicit opt-in only. Never runs during app startup, deployment, build, or normal tests.
- Refuses when `NODE_ENV=production`.
- Refuses when target database name is missing or not clearly identified as a demo/seed/test/local/dev database.
- `--apply` requires `--confirm-seed`.
- Idempotent upserts by stable seed `_id` values with seed tag `fixmate-demo-seed-v1`.
- Does not delete collections, does not perform broad wipes, and refuses to overwrite a non-seed document that collides with a seed `_id`.
- Does not create Better Auth credentials/sessions, does not fabricate password hashes, and does not provision Admin.

### Expected seeded records

- 28 approved services: 4 per category across all 7 official categories (Smartphone, Laptop & PC, AC, Refrigerator, TV, Washing Machine, Electrical).
- Demo-only titles, descriptions, areas, durations, and prices are safe non-production placeholders for demonstration; no live marketplace claim is made.
- Existing stable seed service IDs/records are preserved where possible; missing category records are added by deterministic upsert.
- 6 realistic bookings covering valid statuses: requested, accepted, in-progress, completed, cancelled, rejected (includes all required target statuses requested/accepted/rejected/in-progress/completed).
- Bookings are schema-valid direct seed records; terminal records do not include `activeBookingKey`, active records do.
- Completed seed booking has `finalAmount` and `paymentStatus: "unpaid"`; no booking is marked paid without a real verified payment workflow.

### Required existing users

Because FixMate uses Better Auth for authentication, this seed script does **not** create login-capable Technician/Customer accounts. You must provide existing canonical `user` IDs:

- At least 2 existing users with role `technician`.
- 1 existing user with role `customer`.

**Technician slot mapping (deterministic seed assignment):**

- `--technician-id` #1 (techA slot): assigned all Laptop & PC services and a balanced share of other categories. Owner-reported demo mapping: this should be the Istiak technician account.
- `--technician-id` #2 (techB slot): assigned remaining services. Owner-reported demo mapping: this should be the Nayim technician account.

This corrects the owner-reported Laptop technician assignment issue at the seed-data level. Do not invent identities; pass the actual canonical `user` IDs for the intended accounts when running in a safe non-production demo database.

### ImgBB image compliance (owner action required)

- The official ImgBB guide is not present in the workspace docs; exact assignment-required ImgBB URL format cannot be fully confirmed here.
- Current seed service images use Unsplash HTTPS URLs (`images.unsplash.com`) for realistic demo placeholders. **These are not ImgBB-hosted URLs and are not claimed as ImgBB-compliant.**
- The server/client upload validation allows trusted ImgBB hosts (`i.ibb.co`, `i.imgbb.com`) for real upload flows; seed data has not been migrated to ImgBB because no valid ImgBB URLs were available and no uploads were performed.
- Do not fabricate ImgBB URLs. Do not upload using production credentials. Do not expose ImgBB API keys.

| Service category | Seed services | Current image status | Required owner action | Safe upload workflow |
|---|---:|---|---|---|
| Smartphone | 4 | Unsplash placeholder URL (not ImgBB) | Provide/upload valid ImgBB image per service; replace URL in safe non-prod seed/update workflow | Upload via approved server-mediated ImgBB flow or owner-controlled ImgBB upload; copy returned `i.ibb.co`/`i.imgbb.com` HTTPS URL; update seed record by stable seed `_id`; run seed dry-run then apply in demo DB only |
| Laptop & PC | 4 | Unsplash placeholder URL (not ImgBB) | Same as above | Same as above |
| AC | 4 | Unsplash placeholder URL (not ImgBB) | Same as above | Same as above |
| Refrigerator | 4 | Unsplash placeholder URL (not ImgBB) | Same as above | Same as above |
| TV | 4 | Unsplash placeholder URL (not ImgBB) | Same as above | Same as above |
| Washing Machine | 4 | Unsplash placeholder URL (not ImgBB) | Same as above | Same as above |
| Electrical | 4 | Unsplash placeholder URL (not ImgBB) | Same as above | Same as above |

### Usage

Dry run (no writes):

```bash
npm run seed:demo -- --dry-run --database-name=fixmate_demo --technician-id=<TECHNICIAN_OBJECT_ID_1> --technician-id=<TECHNICIAN_OBJECT_ID_2> --customer-id=<CUSTOMER_OBJECT_ID>
```

Apply (explicit confirmation required):

```bash
npm run seed:demo -- --apply --confirm-seed --database-name=fixmate_demo --technician-id=<TECHNICIAN_OBJECT_ID_1> --technician-id=<TECHNICIAN_OBJECT_ID_2> --customer-id=<CUSTOMER_OBJECT_ID>
```

### Verify

- Confirm the command prints JSON summary with `ok: true` and the intended `databaseName`.
- In MongoDB, verify only seeded records with `seedTag: "fixmate-demo-seed-v1"` in `services` and `bookings`.
- Verify service categories cover all 7 official categories and seeded services are `approved` + `isAvailable: true`.
- Verify bookings reference the supplied customer/technician IDs and seeded service IDs.

### Cleanup

If cleanup is needed, remove only explicitly identified seed records, for example by `seedTag: "fixmate-demo-seed-v1"` in a deliberate manual/admin DB operation against the demo database. Do not run broad collection deletes on shared or production databases.

## Demo Account Setup / Readiness

Do not commit real credentials. Use placeholders and owner-controlled setup.

| Role | Minimum for demo | Email | Password | Setup |
|---|---:|---|---|---|
| Customer | 5 (owner plan) | `<customer-demo-email-{1..5}>` | `<owner-set-password>` | Register through Client/Better Auth flow; verify canonical `user.role=customer`. |
| Technician | 4 (owner plan) | `<technician-demo-email-{1..4}>` | `<owner-set-password>` | Register through Client/Better Auth flow; provision/verify `user.role=technician` through approved owner-controlled/admin workflow. |
| Admin | 1 | `<admin-demo-email>` | `<owner-set-password>` | Manual owner-controlled provisioning only. Do not auto-seed Admin credentials. |

**Account-readiness checklist (owner action required, no accounts created by agent):**

- [ ] Create/verify 5 Customer accounts through Better Auth (no passwords/PII in repo).
- [ ] Create/verify 4 Technician accounts through Better Auth; confirm canonical role is `technician`.
- [ ] Confirm Admin account exists and role is `admin` (manual owner-controlled).
- [ ] Capture canonical `user` ObjectIds for 2 technician accounts used by demo seed (techA/Laptop specialist = owner-reported Istiak; techB = owner-reported Nayim) and 1 customer account used by demo booking seed.
- [ ] Run seed demo in a safe non-production demo database only after owner review (`--dry-run` first, then `--apply --confirm-seed`).
- [ ] Verify seeded services/bookings reference the intended existing users; verify no unrelated records overwritten.
- [ ] Do not mark demo accounts or seeded demo data as live/working without real environment evidence.

Notes:

- Admin provisioning remains deliberate and manual/owner-controlled; see root `AUTH_TEST_ENVIRONMENT.md`.
- Seed script requires existing Technician/Customer IDs and does not create login-capable accounts.

## Submission Readiness Checklist

Status labels: IMPLEMENTED (source present), TESTED (automated/mocked evidence), VERIFIED (review against authoritative owner/live evidence), OWNER ACTION REQUIRED (owner-controlled task), BLOCKED (missing source/action prevents completion).

- [x] IMPLEMENTED — Project purpose/overview, server API responsibilities, repo links, feature list, stack, setup, env variable names (never values), seed/demo instructions, Stripe Test Mode server boundary, and demo account placeholders documented in this README.
- [x] TESTED — Server source/tests cover seed safety/idempotency, 28-service/7-category coverage, booking status coverage, payment idempotency, role/ownership, and paid-only revenue with mocked/local tests.
- [ ] VERIFIED — Official complete Assignment 9 Category 006 specification/guide files are not present in workspace docs; full official reconciliation remains `PENDING OWNER DECISION`.
- [ ] OWNER ACTION REQUIRED — Live Client URL, Server/API URL, real demo credentials, and deployment SHA confirmation must be supplied by owner; no live URL/credential is invented here.
- [ ] OWNER ACTION REQUIRED — 5 Customer / 4 Technician / 1 Admin accounts and canonical ObjectIds for seed references must be created/verified in intended environment.
- [ ] OWNER ACTION REQUIRED — Valid ImgBB URLs for all 28 demo services must be uploaded/provided; current seed URLs are Unsplash placeholders and are not claimed ImgBB-compliant.
- [ ] BLOCKED — Live Stripe Test Mode E2E (real Checkout, signed webhook delivery, paid state, history/admin revenue, duplicate webhook idempotency) requires owner-controlled live evidence.
- [ ] OWNER ACTION REQUIRED — Suspicious historical booking/payment remediation requires owner review, correct amount confirmation, and explicit authorization before the guarded Phase 41 script is applied.
- [ ] OWNER ACTION REQUIRED — Production smoke/responsive/error checks, official X handle decision (D7), and secure submission credential/live URL handoff.

## Deployment / Production Status

- Live API deployment: `PENDING OWNER DEPLOYMENT`.
- Production MongoDB/Stripe/ImgBB/live E2E verification: not claimed here.
- Any deployment config added later must keep Client and Server independent.
