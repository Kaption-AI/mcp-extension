# @kaptionai/mcp-extension

MCP server that lets AI assistants read your WhatsApp conversations through the [KaptionAI](https://kaptionai.com) Chrome extension.

```
Claude / Cursor ──stdio──> mcp-whatsapp ──ws://localhost:7865──> KaptionAI Extension ──> WhatsApp Web
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
      "args": ["-y", "@kaptionai/mcp-extension"]
    }
  }
}
```

**Claude Code**

```bash
claude mcp add whatsapp -- npx -y @kaptionai/mcp-extension
```

**Cursor**

Add to `.cursor/mcp.json` in your project or go to Settings > MCP Servers:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": ["-y", "@kaptionai/mcp-extension"]
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
      "args": ["-y", "@kaptionai/mcp-extension"]
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
      "args": ["-y", "@kaptionai/mcp-extension"]
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
        "args": ["-y", "@kaptionai/mcp-extension"]
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
        "args": ["-y", "@kaptionai/mcp-extension"]
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
    args=["-y", "@kaptionai/mcp-extension"],
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
npx -y @kaptionai/mcp-extension
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

## Multi-instance support

Multiple AI tools can share the same extension connection. The first instance starts a WebSocket hub; subsequent instances auto-detect the existing hub and relay through it. If the hub stops, a relay automatically promotes itself.

## Security

- **Localhost only** — no cloud relay, no external connections
- **Read-only by default** — conversations and messages are never modified
- **Locked chats hidden** — WhatsApp-locked conversations are excluded from all queries
- **Feature-gated** — MCP bridge must be explicitly enabled in the extension
- **Business features gated** — labels and notes require a WhatsApp Business account

## License

[BSL 1.1](./LICENSE) — free to use, converts to MIT after 4 years.
