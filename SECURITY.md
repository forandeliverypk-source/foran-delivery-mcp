# Security policy

Please report security issues privately to **contact@forandelivery.com** (subject: "MCP security"). Do not open public issues for vulnerabilities. We reply within 3 working days.

## Design notes
- Customer-only: the server calls the Foran customer API only. It has no admin, vendor or rider credentials or endpoints.
- Stateless: the customer's API token is sealed in an AES-256-GCM `session_key` with the server secret `FORAN_MCP_SECRET`. Nothing is written to disk.
- Orders and cancellations need an explicit second call with `confirm=true`.
- The hosted server applies a per-IP rate limit and a Host allow-list, and runs as an unprivileged systemd user with a read-only file system.
