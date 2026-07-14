# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `@kaptionai/mcp-extension` (the `mcp-whatsapp` local MCP server), please report it privately:

- **Email:** security@kaptionai.com
- Include a description, reproduction steps, affected version, and impact.
- Please do **not** open a public GitHub issue for security reports.

We aim to acknowledge reports within 3 business days and to share a remediation timeline after triage. Coordinated disclosure is appreciated — please give us a reasonable window to ship a fix before any public disclosure.

## Supported Versions

The latest version published to npm receives security fixes. Older versions are not maintained.

## Security Model

`mcp-whatsapp` is a **local** MCP server. It binds only to loopback (`127.0.0.1`) and bridges to the Kaption browser extension over `ws://127.0.0.1:7865` and `http://127.0.0.1:7866` — it is not exposed to the network.

- **Authentication.** The HTTP bridge requires a 256-bit bearer token stored at `~/.kaptionai/mcp-auth-token` (file mode `0600`) and compared in constant time. Relay/extension pairing uses per-session tokens (stored as SHA-256 hashes) with a rolling 7-day expiry; session IDs are validated against a strict pattern before any filesystem access.
- **Data handling.** WhatsApp data is read on demand and returned to the connected MCP client; this server persists no message contents. Media bytes are inlined only for an explicit `download_media` call.
- **Tool safety.** Every tool carries MCP annotations (`readOnlyHint` / `destructiveHint`) so clients can apply user-in-the-loop confirmation for state-changing actions. There is no bare "send a message" tool; `manage_scheduled_messages` can schedule a deferred send and is annotated `destructiveHint: true`.

## In Scope

Authentication bypass on the local bridge, path traversal, command/prompt injection, unsafe deserialization, or any path that lets a non-loopback or unauthorized caller reach tool execution or user data. Dependency vulnerabilities with a practical exploit path are also welcome.
