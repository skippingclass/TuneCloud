# Deployment notes for the security fixes

Web and Subsonic continue to use the **same account and password**. Password viewing and copying in the admin panel has been removed. Administrators can create accounts and reset passwords.

## Before deployment

- Use Node.js 22.15 or newer (22.23+ recommended for the included tooling). Fastify and the metadata parser have been upgraded with their compatible plugins.
- Set a unique random `JWT_SECRET` (at least 32 characters) and a unique `ADMIN_PASSWORD` (12–72 UTF-8 bytes in production). Shipped placeholders and `admin/admin` are rejected. Compose also requires an explicit database password. An existing admin password is not reset by changing the bootstrap environment variable; use password reset in the admin panel.
- Migration `007` adds session versions and missing-file markers without deleting existing data. Existing web sessions need to sign in again. Password resets, role changes, deletion and logout revoke old tokens immediately. Logout revokes all web sessions for that account.
- Audio URLs no longer carry JWTs. Web login and session checks set an HttpOnly, SameSite=Strict cookie scoped to `/api/stream`. Production defaults to Secure cookies, including behind an HTTPS ingress. Set `COOKIE_SECURE=true` on HTTPS installations; explicitly use false only for HTTP. The HTTP-oriented example .env sets false. Keep web and API on the same origin.
- `TRUSTED_PROXIES` must contain the IPs/CIDRs of actual reverse proxies. Outside Compose the default is to trust none. Compose trusts the private container network and its nginx overwrites incoming `X-Forwarded-For`. Configure any additional ingress to strip untrusted forwarding headers and to omit credentials/query strings from access logs. nginx and Fastify in this repository log paths without queries.
- `.env`, node_modules and cached media are excluded from Docker builds. The server image copies only package metadata and source. Review old images and rotate any secrets that were previously included or logged.

The client build tooling was also upgraded to remove vulnerable transitive dependencies (Vite 7 and Tailwind CSS 4). The existing theme configuration and button styles are preserved. Tailwind 4 requires modern browsers: Safari 16.4+, Chrome 111+, Firefox 128+; see the [official migration guide](https://tailwindcss.com/docs/upgrade-guide).

## Password encryption and Subsonic compatibility

Subsonic's token-and-salt protocol requires the original password to calculate MD5(password + salt). The server retains an encrypted copy for that protocol, never exposes it through the user API, and continues to use bcrypt for web login. No separate passwords or accounts are introduced.

Optionally configure a stable `SUBSONIC_ENCRYPTION_KEY` independently from JWT signing. **Set the encryption key and restart with the OLD JWT_SECRET first** so existing encrypted passwords are migrated. After that, JWT_SECRET can be rotated without breaking Subsonic credentials. If both keys are lost/changed before migration, users must log into the web UI once or have their password reset to refresh their Subsonic secret.

## Music library and editing

Missing audio is marked with `missing_since`, never automatically deleted from the database. Favorites, playlists and history retain their track IDs through a disconnected or empty mount. A later scan clears the marker when a file returns. Permanently missing records are retained; automatic destructive cleanup is intentionally disabled.

The default Docker music mount remains read-only. To enable MP3 tag editing, set **both** `MUSIC_MOUNT_MODE=rw` and `TAG_EDITING_ENABLED=true`, and grant the container's node user permission to write the music directory. Tag changes are staged in the same directory and atomically replace the source after database updates succeed. Recoverable database errors restore the original; a process/host crash between the filesystem and database commits can still require a rescan. `.bak` files left after a failed recovery must be retained for recovery.

## Verification

- `npm run check --prefix server`
- `bash server/scripts/test-postgres.sh` creates a separate disposable PostgreSQL cluster under `/tmp`; PostgreSQL command-line tools must be installed. It stops the cluster after the run; the stopped cluster's directory is retained for inspection.
- Alternatively, set `TEST_DATABASE_URL` to a dedicated test PostgreSQL database and run `npm test --prefix server`. Tests use and drop a randomly named isolated schema. **Never point this variable at production.** Without it, integration tests are skipped.
- `npm test --prefix client`
- `npm run build --prefix client`

CI runs server syntax checks, server integration tests, client tests and the client build before publishing images or updating GitOps. Production deployment is a separate step; these changes do not deploy or alter the running production database.
