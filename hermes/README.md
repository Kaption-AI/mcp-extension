# Kaption for WhatsApp — Hermes plugin

Connects Hermes to your own WhatsApp through Kaption's hosted MCP server (`https://mcp.kaptionai.com/mcp`, Streamable HTTP, OAuth 2.1 with PKCE and dynamic client registration). Bundles the `kaption-whatsapp` skill.

## Install

```bash
hermes plugins install kaption-whatsapp
hermes mcp add kaption --url https://mcp.kaptionai.com/mcp --auth oauth --connect-timeout 300
```

The second command turns on OAuth: a browser window opens, and you sign in with your WhatsApp phone number and a 6-digit code sent to you on WhatsApp. Without it the server answers 401.

You also need Kaption running on your computer: the Kaption extension in WhatsApp Web (Chrome or Edge) or the Kaption desktop app (Mac, Windows), with Cloud MCP turned on (extension: AI Assistants (MCP) › Cloud Bridge › Enable; desktop app: Settings › Cloud MCP).

## What it can do

Search and read chats, contacts, groups and voice-note transcripts; summarize a chat; set reminders; manage labels, lists and notes; list call recordings; schedule messages, and send a message from your computer after you confirm it. The server is marked `untrusted`, so Hermes asks before every tool that is not read-only, and refuses them in unattended runs.

## Data

Hosted-only connector, no local code. Every tool call goes to mcp.kaptionai.com, which checks the sign-in and relays the call to Kaption on your computer; Kaption's relay does not store messages. What the tools return (messages, transcripts, contact names) enters the Hermes session and reaches your model provider. The tool list is served by the remote server at run time and is not covered by the pinned commit.

Plans and limits: https://kaptionai.com/pricing/ · Privacy: https://kaptionai.com/privacy/ · Docs: https://kaptionai.com/mcp/
