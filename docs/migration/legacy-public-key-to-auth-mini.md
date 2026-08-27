# Legacy public-key ownership migration

The TypeScript service owns each SQLite database by a browser-generated Ed25519 public key. The Rust service owns each database by an authenticated Auth Mini subject. These identities have no source-backed mapping, so migration is explicit and never automatic.

```bash
remi-migrate-legacy \
  --legacy-db /path/to/legacy.sqlite \
  --target-db /var/lib/remi/users/<hashed-subject>.sqlite \
  --owner-subject <auth-mini-subject>
```

The command opens the legacy database read-only, creates a backup under `legacy-backups/`, and transactionally imports anchors, messages, and candidate queue records with deterministic UUIDv5 values and `legacy_id` idempotency keys.

The following legacy material remains in the backup/export boundary because it cannot be safely assigned to an Auth Mini subject: direct messages, public-profile/avatar blobs, API tokens, and goal execution records.
