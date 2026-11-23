# FixMate Server

FixMate Server is the independent Express/MongoDB backend for FixMate, a role-based smart-device and home-appliance repair marketplace (Assignment 9, Category 006). It exposes authenticated JSON APIs for services, bookings, payments, profile/admin operations, and image uploads, while enforcing server-side authorization, ownership, validation, and Stripe webhook verification.

## Live API URL

- Live API URL: `PENDING OWNER DEPLOYMENT` (no live deployment is claimed by this repository)

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

- 12 approved services across all official categories: Smartphone, Laptop & PC, AC, Refrigerator, TV, Washing Machine, Electrical.
- 6 realistic bookings covering several valid statuses: requested, accepted, in-progress, completed, cancelled, rejected.
- Bookings are schema-valid direct seed records; terminal records do not include `activeBookingKey`, active records do.

### Required existing users

Because FixMate uses Better Auth for authentication, this seed script does **not** create login-capable Technician/Customer accounts. You must provide existing canonical `user` IDs:

- At least 2 existing users with role `technician`.
- 1 existing user with role `customer`.

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

## Demo Account Setup

Do not commit real credentials. Use placeholders and owner-controlled setup:

| Role | Email | Password | Setup |
|---|---|---|---|
| Customer | `<customer-demo-email>` | `<owner-set-password>` | Register through the Client/Better Auth flow, then confirm role is `customer` in canonical `user` collection if needed. |
| Technician | `<technician-demo-email-1>` | `<owner-set-password>` | Register through the Client/Better Auth flow and provision technician role through the approved owner-controlled process/admin workflow as applicable. |
| Technician | `<technician-demo-email-2>` | `<owner-set-password>` | Register through the Client/Better Auth flow and provision technician role through the approved owner-controlled process/admin workflow as applicable. |
| Admin | `<admin-demo-email>` | `<owner-set-password>` | Manual owner-controlled provisioning only. Do not auto-seed Admin credentials. |

Notes:

- Admin provisioning remains deliberate and manual/owner-controlled; see root `AUTH_TEST_ENVIRONMENT.md` for the manual provisioning workflow and environment assumptions.
- Seed script requires existing Technician/Customer IDs and does not create login-capable accounts.
- Do not mark demo accounts as live/working until actually created and tested in the intended environment.

## Deployment / Production Status

- Live API deployment: `PENDING OWNER DEPLOYMENT`.
- Production MongoDB/Stripe/ImgBB/live E2E verification: not claimed here.
- Any deployment config added later must keep Client and Server independent.
