# FixMate Server Agent Instructions

Before work, read the workspace-level `..\AGENTS.md` (especially `SELF-AUDIT AND DOCUMENTATION MAINTENANCE`), `..\PROJECT_CONTEXT.md`, `..\REQUIREMENTS_TRACKER.md`, `..\ARCHITECTURE.md`, `..\DESIGN_SYSTEM.md`, `..\ASSET_MANIFEST.md`, `..\DEVELOPMENT_PLAN.md`, `..\DEVELOPMENT_LOG.md`, and `..\NEXT_SESSION.md`. Then inspect the actual source code to be changed.

- This repository is the independent FixMate Server. Keep its repository, dependencies, and deployment separate from `fixmate-client/`; do not create a monorepo.
- Use Express and MongoDB. Prefer JavaScript/ES modules, matching `package.json`.
- Keep exactly four application data collections: `users`, `services`, `bookings`, and `payments`. Better Auth internal auth collections are separate. Do not invent schemas; reconcile exact fields with the official assignment first.
- Implement Better Auth JWT verification through JWKS with `jose`. Create the verifier once during startup. Reject invalid/expired/wrongly issued tokens with 401.
- After token verification, load the latest user record from MongoDB. Reject missing users and attach the verified database record to `req.user`. Controllers must never use client-supplied identity.
- Enforce role, ownership, input validation, and allowed state transitions on every protected operation. Return 403 for role mismatch. Frontend checks are not authorization.
- Use consistent response/error formats; fail explicitly on missing configuration or database startup errors. Do not silently swallow exceptions or expose internals.
- Configure CORS from an explicit allowed Client origin; do not use unrestricted defaults in production.
- Stripe Checkout must use the persisted booking `finalAmount`, only for completed/unpaid bookings. Keep secrets server-side, verify webhook signatures against the raw body, and make processing idempotent.
- Do not expose private ImgBB keys. Follow the supplied integration guide once available; current exact upload boundary is pending.
- Preserve `.env` values and ignore rules. Never print, copy, or commit secrets. Current `.gitignore` excludes `.env`, `.env.*`, and `node_modules/`.
- Update `..\REQUIREMENTS_TRACKER.md` and relevant architecture docs with evidence. Do not mark requirements tested without tests.
- Phase 1 foundation is implemented: `npm run dev`, `npm run start`, `npm test`, and `npm run check` are real scripts. Keep tests and documentation evidence-based.
- Preserve user changes and repository history. Do not commit or push unless explicitly authorized.
- The 2026-11-21 documentation-only self-audit changed no application source, design asset, dependency, environment value, or Git history. The later Phase 1 server implementation is documented in the root `DEVELOPMENT_LOG.md`.
- Phase 2 authentication is currently blocked: the Client has no Better Auth `jwt()` plugin and the exact issuer/JWKS/audience/algorithm/identity mapping are `PENDING OWNER DECISION`. The application `users` collection and lowercase `role` values are confirmed; `jose` is authorized but not installed. Do not wire a verifier or accept Bearer tokens until the contract is supplied.
