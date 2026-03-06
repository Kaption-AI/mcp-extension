import { z } from 'zod';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'query',
    description: [
      'Query WhatsApp data: conversations, contacts, messages, transcriptions, labels, and communities.',
      'Supports listing, searching, filtering, and looking up by ID.',
      '',
      'IMPORTANT: Multiple WhatsApp accounts may be connected (e.g. personal + business).',
      'Always query entity="session" FIRST to see all connected accounts and their session IDs.',
      'Then use target_session to route queries to the correct account.',
      'Each account has different conversations, contacts, and messages.',
      '',
      'Examples:',
      '  List sessions: { entity: "session" }',
      '  List conversations: {}',
      '  Target specific account: { entity: "conversations", target_session: "sess_abc123" }',
      '  Search everything: { query: "meeting" }',
      '  Unread conversations: { unread: true }',
      '  Lookup conversation: { id: "5491157390064@c.us" }',
      '  Search contacts: { query: "Alice", entity: "contacts" }',
      '  List labels: { entity: "labels" }',
      '  Filter by label: { label: "Important", entity: "conversations" }',
      '  List communities: { entity: "communities" }',
      '  Filter by community: { community: "My Community", entity: "conversations" }',
    ].join('\n'),
    inputSchema: z.object({
      query: z.string().optional().describe('Text to search for (names, messages, transcriptions)'),
      id: z.string().optional().describe('Look up a specific conversation, contact, or label by ID'),
      entity: z
        .enum(['conversations', 'contacts', 'messages', 'transcriptions', 'labels', 'communities', 'session'])
        .optional()
        .describe(
          'Entity type to query. Defaults to "conversations" when listing, or all when searching. Use "session" to list all connected WhatsApp accounts.'
        ),
      limit: z.number().min(1).max(5000).optional().default(25).describe('Max results (default 25, max 5000)'),
      unread: z.boolean().optional().describe('Only return conversations with unread messages'),
      label: z.string().optional().describe('Filter conversations by label name or ID (Business only)'),
      community: z.string().optional().describe('Filter conversations by community name or ID'),
      before: z.string().optional().describe('Return messages before this ISO 8601 datetime (e.g. "2026-03-01T12:00:00.000Z") for cursor-based pagination backward'),
      after: z.string().optional().describe('Return messages after this ISO 8601 datetime (e.g. "2026-03-01T12:00:00.000Z") for incremental sync'),
      target_session: z.string().optional().describe('Session ID to target a specific WhatsApp account. Get session IDs from entity="session". If omitted, routes to the most recently active account.'),
    }),
  },
  {
    name: 'summarize_conversation',
    description: 'Get or generate a summary of a conversation',
    inputSchema: z.object({
      conversation_id: z.string().describe('The conversation ID'),
      target_session: z.string().optional().describe('Session ID to target a specific WhatsApp account'),
    }),
  },
  {
    name: 'manage_labels',
    description: [
      'Manage WhatsApp Business labels. Requires a WhatsApp Business account.',
      '',
      'Actions:',
      '  add    - Add a label to a conversation (requires label_name/label_id + conversation_id)',
      '  remove - Remove a label from a conversation (requires label_name/label_id + conversation_id)',
      '  create - Create a new label (requires label_name)',
      '  delete - Delete a label (requires label_name or label_id)',
    ].join('\n'),
    inputSchema: z.object({
      action: z.enum(['add', 'remove', 'create', 'delete']).describe('Label action to perform'),
      label_name: z.string().optional().describe('Label name (for add/remove/create/delete)'),
      label_id: z.string().optional().describe('Label ID (alternative to label_name for add/remove/delete)'),
      conversation_id: z.string().optional().describe('Conversation ID (required for add/remove)'),
    }),
  },
  {
    name: 'manage_notes',
    description: [
      'Manage contact notes. Requires a WhatsApp Business account with notes enabled.',
      '',
      'Actions:',
      '  get - Read the note for a contact',
      '  set - Write/update the note for a contact',
    ].join('\n'),
    inputSchema: z.object({
      action: z.enum(['get', 'set']).describe('Note action to perform'),
      contact_id: z.string().describe('The contact ID'),
      note: z.string().optional().describe('Note text (required for "set" action)'),
    }),
  },
  {
    name: 'download_media',
    description: [
      'Download media content (image, video, audio, document, sticker) from a WhatsApp message.',
      'Returns base64-encoded media data with metadata.',
      '',
      'Get message_id from query results. The message must be a media message.',
      '',
      'Examples:',
      '  Download an image: { message_id: "true_123@c.us_3EB0...", conversation_id: "123@c.us" }',
    ].join('\n'),
    inputSchema: z.object({
      message_id: z.string().describe('The message ID (from query results)'),
      conversation_id: z.string().describe('The conversation ID containing the message'),
      target_session: z.string().optional().describe('Session ID for multi-account routing'),
    }),
  },
  {
    name: 'get_api_info',
    description: 'Get HTTP REST API connection info for programmatic access without MCP overhead. Returns URL, auth token, and available endpoints.',
    inputSchema: z.object({}),
  },
];

/**
 * Get a tool definition by name
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Convert tool definitions to MCP-compatible format (JSON Schema)
 */
export function getToolsForMCP(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
  }));
}

/**
 * Simple zod-to-JSON-Schema converter for the subset we use
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const zodValue = value as z.ZodType;
      const propSchema = zodToJsonSchema(zodValue);
      properties[key] = propSchema;

      // Check if the field is required (not optional and not defaulted)
      if (!(zodValue instanceof z.ZodOptional) && !(zodValue instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    const result: Record<string, unknown> = {
      type: 'object',
      properties,
    };
    if (required.length > 0) {
      result.required = required;
    }
    return result;
  }

  if (schema instanceof z.ZodString) {
    return { type: 'string', description: schema.description };
  }

  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: 'number' };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: 'boolean' };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: schema.options, description: schema.description };
  }

  if (schema instanceof z.ZodOptional) {
    const inner = zodToJsonSchema(schema.unwrap());
    if (schema.description && !inner.description) {
      return { ...inner, description: schema.description };
    }
    return inner;
  }

  if (schema instanceof z.ZodDefault) {
    const inner = zodToJsonSchema(schema.removeDefault());
    const result: Record<string, unknown> = { ...inner, default: schema._def.defaultValue() };
    if (schema.description && !result.description) {
      result.description = schema.description;
    }
    return result;
  }

  return { type: 'object' };
}
