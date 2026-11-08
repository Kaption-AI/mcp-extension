---
name: kaption-whatsapp
description: Work with the user's WhatsApp through the Kaption MCP server (search chats, read transcripts, summarize conversations, find contacts, manage labels, notes and reminders, schedule a message, list call recordings). Use when the user asks about their WhatsApp messages, contacts or groups, wants a chat or group summarized, wants a reminder or a follow-up scheduled on WhatsApp, or wants to connect WhatsApp to Claude, ChatGPT, Cursor or another MCP client.
---

# Kaption WhatsApp

Kaption connects WhatsApp to AI assistants through MCP. The tools run against the user's own WhatsApp, through the Kaption Chrome/Edge extension in WhatsApp Web or the Kaption desktop app on their computer. Kaption's relay checks the sign-in and does not store messages.

## Connect

- **Remote (recommended):** add `https://mcp.kaptionai.com/mcp` as a remote MCP server (Streamable HTTP, OAuth 2.1 with PKCE and dynamic client registration). The user signs in with their phone number and a 6-digit code sent on WhatsApp.
  - Claude: Customize › Connectors › + Add › Add custom connector. Claude Code: `claude mcp add --transport http whatsapp https://mcp.kaptionai.com/mcp`.
  - Cursor: `{"mcpServers": {"whatsapp": {"url": "https://mcp.kaptionai.com/mcp"}}}` in `~/.cursor/mcp.json`.
  - Guides: https://kaptionai.com/mcp/claude/, https://kaptionai.com/mcp/chatgpt/, https://kaptionai.com/mcp/cursor/
- **Local:** `npx -y @kaptionai/mcp-extension@latest` (stdio, Node.js 18+), with the MCP bridge turned on in the extension.
- On the Kaption side the user must turn on Cloud MCP (extension: AI Assistants (MCP) › Cloud Bridge › Enable; desktop app: Settings › Cloud MCP) and keep Kaption open.

## Tools

| Tool | Use it to |
|------|-----------|
| `query` | Search and list conversations, contacts, messages, voice-note transcriptions, labels and communities |
| `summarize_conversation` | Summarize a chat or group |
| `list_contacts` / `get_contact` / `get_contact_groups` / `export_contacts` | Look up contacts, the groups you share with them, or export them |
| `list_groups` / `get_group` | List groups, or get one group's live member list |
| `get_chat_list` / `list_chat_lists` | Read WhatsApp's own chat lists |
| `get_analytics` | Message activity over a period |
| `manage_chat` | Archive, pin, mute, mark read or unread, set a draft |
| `manage_labels` / `manage_lists` | Organize chats with Business labels or personal lists |
| `manage_notes` / `get_contact_note` | Read and write contact notes (WhatsApp Business) |
| `manage_reminders` / `list_reminders` / `get_reminder` | Set reminders on chats and messages (nothing is sent to anyone) |
| `manage_scheduled_messages` / `list_scheduled_messages` / `get_scheduled_message` | Schedule, list, edit and cancel messages |
| `send_message` | Send a message from the user's computer, after they confirm it (see Rules) |
| `create_attachment_upload` | Upload a file to attach to a message you send or schedule |
| `download_media` | Download a voice note, image, video or document from a message |
| `call_recordings` | List, read and search WhatsApp call recordings and their timed transcripts |
| `list_status_posts` | List the user's own recent Status posts |
| `get_kaption_settings` / `update_kaption_settings` | Read or change Kaption settings |
| `kaption_help` / `kaption_plans` / `report_bug` | Answer questions about Kaption, show the plans, report a problem |
| `reconnect_kaption_connection` | Repair the connection when Kaption stops answering |

## Rules

1. **Search before you read.** Use `query` with a name, phone number or keyword to find the chat, then read only what the task needs. Prefer `summarize_conversation` over pulling hundreds of messages.
2. **Never send on your own.** Before `send_message` or `manage_scheduled_messages`, confirm the exact text, the recipient and (for a scheduled message) the time with the user. Times are the user's local time. `send_message` goes out from the user's own number on their computer, queued for the earliest permitted delivery, up to 8 an hour and 20 a day. The user can turn it off in Kaption ("Let assistants send messages from this computer"); if it is off, schedule the message instead.
3. **Reminders vs. scheduled messages.** If the next step depends on whether the contact replies, set a reminder. If the text holds no matter what, schedule it.
4. **No bulk messaging.** Don't schedule the same message to many contacts or to people who don't expect it. It breaks Kaption's terms and can get the user's number banned by WhatsApp.
5. **Privacy.** Quote only what the user needs. Locked chats are never visible to the tools; don't try to work around that.
6. **Several numbers.** If more than one WhatsApp account is connected (`query` with `entity: "session"`), ask which one to use and pass `target_session`.

## Errors

- **"Extension not connected"**: Kaption is closed or Cloud MCP is off. Ask the user to open WhatsApp Web with the extension, or the desktop app, and turn the connection on.
- **401 with `WWW-Authenticate`**: sign in again through the client's OAuth flow.
- **Limit reached**: the plan's monthly Claude and ChatGPT credits are used up. Every account is unlimited for its first 60 days; after that, credits come with a plan: Lifetime local AI 50 a month, Pro 250, Business 500 (250 per WhatsApp number). Each request uses a few. The count starts again on the first day of each month. Point the user to https://kaptionai.com/pricing/; the assistant stays connected.

More: https://kaptionai.com/llms.txt and https://kaptionai.com/developers/
