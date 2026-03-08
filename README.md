# @kaptionai/mcp-extension

MCP server that lets AI assistants read and manage your WhatsApp conversations through the [KaptionAI](https://kaptionai.com) Chrome extension. Also supports [WebMCP](https://webmachinelearning.github.io/webmcp/) for zero-config browser-native AI tool discovery.

```
Claude / Cursor ──stdio──> mcp-whatsapp ──ws://localhost:7865──> KaptionAI Extension ──> WhatsApp Web
Browser AI Agent ──navigator.modelContext──> KaptionAI Extension ──> WhatsApp Web (WebMCP)
```

## Setup

### 1. Install the extension

Install the [KaptionAI Chrome Extension](https://kaptionai.com/extension) and enable the MCP bridge in settings.

### 2. Configure your AI tool

**Claude Desktop**

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": ["-y", "@kaptionai/mcp-extension@latest"]
    }
  }
}
```

**Claude Code**

```bash
claude mcp add whatsapp -- npx -y @kaptionai/mcp-extension@latest
```

**Cursor**

Add to `.cursor/mcp.json` in your project or go to Settings > MCP Servers:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": ["-y", "@kaptionai/mcp-extension@latest"]
    }
  }
}
```

**Windsurf**

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": ["-y", "@kaptionai/mcp-extension@latest"]
    }
  }
}
```

**VS Code (Copilot)**

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "whatsapp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kaptionai/mcp-extension@latest"]
    }
  }
}
```

Or add to your VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "whatsapp": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@kaptionai/mcp-extension@latest"]
      }
    }
  }
}
```

**Zed**

Add to Zed settings (`~/.config/zed/settings.json`):

```json
{
  "context_servers": {
    "whatsapp": {
      "command": {
        "path": "npx",
        "args": ["-y", "@kaptionai/mcp-extension@latest"]
      }
    }
  }
}
```

**OpenAI Agents SDK (Python)**

```python
from agents import Agent
from agents.mcp import MCPServerStdio

whatsapp = MCPServerStdio(
    name="whatsapp",
    command="npx",
    args=["-y", "@kaptionai/mcp-extension@latest"],
)

agent = Agent(
    name="assistant",
    instructions="You can access WhatsApp conversations.",
    mcp_servers=[whatsapp],
)
```

**Any MCP-compatible client**

This package runs as a standard MCP server over stdio. To connect from any client:

```bash
npx -y @kaptionai/mcp-extension@latest
```

The server communicates via stdin/stdout using the MCP protocol. Point your client's MCP configuration to this command.

### 3. Open WhatsApp Web

Open [web.whatsapp.com](https://web.whatsapp.com) in Chrome or Edge. The extension will auto-connect to the MCP server.

## Tools

### `query`

Query WhatsApp data — conversations, contacts, messages, transcriptions, labels, and communities.

```
# List conversations
query {}

# Search everything
query { query: "meeting" }

# Unread only
query { unread: true }

# Look up a conversation with messages
query { id: "5511999887766@c.us" }

# Search contacts
query { query: "Alice", entity: "contacts" }

# List labels (Business accounts)
query { entity: "labels" }

# Filter by label
query { label: "Important" }

# List communities
query { entity: "communities" }

# Filter by community
query { community: "My Community" }

# Get session info
query { entity: "session" }
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search text (names, messages, transcriptions) |
| `id` | string | Look up a specific conversation, contact, or label |
| `entity` | string | `conversations`, `contacts`, `messages`, `transcriptions`, `labels`, `communities`, `session` |
| `limit` | number | Max results (default 25, max 5000) |
| `unread` | boolean | Only unread conversations |
| `label` | string | Filter by label name or ID |
| `community` | string | Filter by community name or ID |
| `before` | string | Messages before this ISO 8601 timestamp (pagination) |
| `after` | string | Messages after this ISO 8601 timestamp (incremental sync) |

### `summarize_conversation`

Generate a summary of a conversation.

| Parameter | Type | Description |
|-----------|------|-------------|
| `conversation_id` | string | The conversation ID |

### `manage_labels`

Manage WhatsApp Business labels — add, remove, create, or delete labels.

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | `add`, `remove`, `create`, `delete` |
| `label_name` | string | Label name |
| `label_id` | string | Label ID (alternative to name) |
| `conversation_id` | string | Required for add/remove |

### `manage_lists`

Manage personal chat lists (custom lists). The personal account equivalent of Business labels — organize chats into custom categories.

```
# List all custom lists
manage_lists { action: "list" }

# Get a list with its chats
manage_lists { action: "get", name: "Family" }

# Create a new list
manage_lists { action: "create", name: "Work", conversation_id: "5511999887766@c.us" }

# Add a chat to a list
manage_lists { action: "add_chat", name: "Family", conversation_id: "5511999887766@c.us" }

# Remove a chat from a list
manage_lists { action: "remove_chat", name: "Family", conversation_id: "5511999887766@c.us" }

# Delete a list
manage_lists { action: "delete", name: "Old List" }
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | `list`, `get`, `create`, `edit`, `delete`, `add_chat`, `remove_chat` |
| `id` | string | List ID |
| `name` | string | List name (for create/edit, or to resolve by name) |
| `conversation_id` | string | Chat ID(s) to add/remove |

### `manage_chat`

Manage chat state — archive, unarchive, mark as read/unread, pin, unpin, mute, unmute, set/clear draft messages.

```
# Archive a chat
manage_chat { action: "archive", conversation_id: "5511999887766@c.us" }

# Mark as read
manage_chat { action: "mark_read", conversation_id: "5511999887766@c.us" }

# Pin a chat (max 3)
manage_chat { action: "pin", conversation_id: "5511999887766@c.us" }

# Mute for 1 week
manage_chat { action: "mute", conversation_id: "5511999887766@c.us", mute_duration: "1w" }

# Set a draft message
manage_chat { action: "set_draft", conversation_id: "5511999887766@c.us", text: "Hey, I'll call you back" }
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | `archive`, `unarchive`, `mark_read`, `mark_unread`, `pin`, `unpin`, `mute`, `unmute`, `set_draft`, `clear_draft` |
| `conversation_id` | string | The conversation ID |
| `mute_duration` | string | `8h`, `1w`, or `forever` (default). Only for `mute` |
| `text` | string | Draft text. Required for `set_draft` |

### `manage_reminders`

Create and manage personal reminders. Stored in the cloud and delivered via the Kaption extension.

```
# List active reminders
manage_reminders { action: "list" }

# Create a reminder
manage_reminders { action: "create", title: "Follow up with client", datetime: "2026-03-07T14:00:00Z" }

# Complete a reminder
manage_reminders { action: "complete", id: "rem_abc123" }

# List all including completed
manage_reminders { action: "list", filter: "all" }
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | `list`, `get`, `create`, `update`, `delete`, `complete`, `uncomplete` |
| `filter` | string | For list: `active` (default), `completed`, `all` |
| `id` | string | Reminder ID (for get/update/delete/complete/uncomplete) |
| `title` | string | Reminder text (max 800 chars, no newlines) |
| `datetime` | string | ISO 8601 datetime |
| `notification_type` | string | `extension`, `whatsapp`, or `automatic` (default) |

### `manage_scheduled_messages`

Schedule messages to be sent automatically at a specific time. Only works for 1:1 chats.

```
# List pending messages
manage_scheduled_messages { action: "list" }

# Schedule a message
manage_scheduled_messages { action: "create", message: "Hey, just following up!", datetime: "2026-03-07T09:00:00Z", conversation_id: "5511999887766@c.us" }

# Cancel a scheduled message
manage_scheduled_messages { action: "delete", id: "msg_abc123" }
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | `list`, `get`, `create`, `update`, `delete` |
| `filter` | string | For list: `pending` (default), `sent`, `all` |
| `id` | string | Scheduled message ID (for get/update/delete) |
| `conversation_id` | string | Contact/chat ID to send to (for create) |
| `message` | string | Message text (max 800 chars, no newlines) |
| `datetime` | string | ISO 8601 datetime when the message should be sent |

### `download_media`

Download and decrypt media from a message (images, videos, audio, documents).

| Parameter | Type | Description |
|-----------|------|-------------|
| `message_id` | string | The message ID containing media |
| `conversation_id` | string | The conversation the message belongs to |

Returns base64-encoded media data with mimetype, size, duration, and caption.

### `manage_notes`

Read and write contact notes (WhatsApp Business).

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | `get`, `set` |
| `contact_id` | string | The contact ID |
| `note` | string | Note text (required for `set`) |

### `get_api_info`

Get HTTP REST API connection info for programmatic access without MCP overhead. Returns URL, auth token, and available endpoints.

## Multi-account support

Multiple WhatsApp accounts can be connected simultaneously (e.g. personal + business). Use `target_session` on any tool to route to a specific account. Query `entity: "session"` to see all connected accounts and their session IDs.

## Multi-instance support

Multiple AI tools can share the same extension connection. The first instance starts a WebSocket hub; subsequent instances auto-detect the existing hub and relay through it. If the hub stops, a relay automatically promotes itself.

## WebMCP support

Kaption is WebMCP-ready. On browsers that support the [W3C WebMCP draft](https://webmachinelearning.github.io/webmcp/) (`navigator.modelContext`, Chrome 146+), the extension automatically registers all tools with the browser's native AI tool registry. This means browser-based AI agents can discover and invoke Kaption tools without any MCP server or WebSocket connection — zero configuration.

When WebMCP is available, the extension registers tools prefixed with `kaption_` (e.g. `kaption_query`, `kaption_manage_chat`) complete with JSON Schema input definitions and `readOnlyHint` annotations. The tools use the same handlers as the MCP server, so behavior is identical across both paths.

## Security

- **Localhost only** — no cloud relay, no external connections
- **No messages sent** — AI assistants can read, organize, schedule, and draft, but never send messages directly
- **Locked chats hidden** — WhatsApp-locked conversations are excluded from all queries
- **Feature-gated** — MCP bridge must be explicitly enabled in the extension
- **Business features gated** — labels and notes require a WhatsApp Business account
- **Rate limited** — draft messages limited to 10 conversations per 5-minute window; write operations include random delays

## License

[BSL 1.1](./LICENSE) — free to use, converts to MIT after 4 years.
