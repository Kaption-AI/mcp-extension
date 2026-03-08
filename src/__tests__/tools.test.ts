import { z } from 'zod';
import { TOOLS, getToolByName, getToolsForMCP } from '../tools';

describe('tools', () => {
  describe('TOOLS array', () => {
    it('should contain all 10 tools', () => {
      expect(TOOLS).toHaveLength(10);
    });

    it('should have unique tool names', () => {
      const names = TOOLS.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    });

    const expectedTools = [
      'query',
      'summarize_conversation',
      'manage_labels',
      'manage_notes',
      'download_media',
      'manage_chat',
      'manage_reminders',
      'manage_scheduled_messages',
      'manage_lists',
      'get_api_info',
    ];

    it.each(expectedTools)('should include tool: %s', (name) => {
      expect(TOOLS.find((t) => t.name === name)).toBeDefined();
    });

    it('should have descriptions for all tools', () => {
      for (const tool of TOOLS) {
        expect(tool.description).toBeTruthy();
        expect(typeof tool.description).toBe('string');
      }
    });

    it('should have zod schemas for all tools', () => {
      for (const tool of TOOLS) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema instanceof z.ZodType).toBe(true);
      }
    });
  });

  describe('getToolByName', () => {
    it('should find existing tool', () => {
      const tool = getToolByName('query');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('query');
    });

    it('should find all tools by name', () => {
      for (const tool of TOOLS) {
        expect(getToolByName(tool.name)).toBe(tool);
      }
    });

    it('should return undefined for unknown tool', () => {
      expect(getToolByName('nonexistent')).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      expect(getToolByName('')).toBeUndefined();
    });
  });

  describe('getToolsForMCP', () => {
    it('should return JSON Schema format for all tools', () => {
      const mcpTools = getToolsForMCP();
      expect(mcpTools).toHaveLength(10);

      for (const tool of mcpTools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('should have properties object for all tools', () => {
      const mcpTools = getToolsForMCP();
      for (const tool of mcpTools) {
        expect(tool.inputSchema.properties).toBeDefined();
        expect(typeof tool.inputSchema.properties).toBe('object');
      }
    });
  });

  describe('query tool schema', () => {
    let schema: Record<string, any>;

    beforeAll(() => {
      schema = getToolsForMCP().find((t) => t.name === 'query')!.inputSchema;
    });

    it('should not require any fields', () => {
      expect(schema.required).toBeUndefined();
    });

    it('should have query param as string', () => {
      expect(schema.properties.query.type).toBe('string');
    });

    it('should have id param as string', () => {
      expect(schema.properties.id.type).toBe('string');
    });

    it('should have limit param as number with default', () => {
      expect(schema.properties.limit.type).toBe('number');
      expect(schema.properties.limit.default).toBe(25);
    });

    it('should have unread param as boolean', () => {
      expect(schema.properties.unread.type).toBe('boolean');
    });

    it('should have entity enum with all entity types', () => {
      const entityEnum = schema.properties.entity.enum;
      expect(entityEnum).toContain('conversations');
      expect(entityEnum).toContain('contacts');
      expect(entityEnum).toContain('messages');
      expect(entityEnum).toContain('transcriptions');
      expect(entityEnum).toContain('labels');
      expect(entityEnum).toContain('communities');
      expect(entityEnum).toContain('session');
    });

    it('should have label param as string', () => {
      expect(schema.properties.label.type).toBe('string');
    });

    it('should have community param as string', () => {
      expect(schema.properties.community.type).toBe('string');
    });

    it('should validate valid query params', () => {
      const tool = getToolByName('query')!;
      const result = tool.inputSchema.safeParse({ query: 'hello', limit: 10, unread: true });
      expect(result.success).toBe(true);
    });

    it('should validate empty params', () => {
      const tool = getToolByName('query')!;
      const result = tool.inputSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should reject invalid limit', () => {
      const tool = getToolByName('query')!;
      const result = tool.inputSchema.safeParse({ limit: 9999 });
      expect(result.success).toBe(false);
    });

    it('should reject invalid entity', () => {
      const tool = getToolByName('query')!;
      const result = tool.inputSchema.safeParse({ entity: 'invalid' });
      expect(result.success).toBe(false);
    });
  });

  describe('summarize_conversation tool schema', () => {
    it('should require conversation_id', () => {
      const schema = getToolsForMCP().find((t) => t.name === 'summarize_conversation')!.inputSchema;
      expect(schema.required).toContain('conversation_id');
    });

    it('should validate valid params', () => {
      const tool = getToolByName('summarize_conversation')!;
      const result = tool.inputSchema.safeParse({ conversation_id: '123@c.us' });
      expect(result.success).toBe(true);
    });

    it('should reject missing conversation_id', () => {
      const tool = getToolByName('summarize_conversation')!;
      const result = tool.inputSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('manage_labels tool schema', () => {
    let schema: Record<string, any>;

    beforeAll(() => {
      schema = getToolsForMCP().find((t) => t.name === 'manage_labels')!.inputSchema;
    });

    it('should require action', () => {
      expect(schema.required).toContain('action');
    });

    it('should have action enum with all actions', () => {
      expect(schema.properties.action.enum).toEqual(['add', 'remove', 'create', 'delete']);
    });

    it('should have optional label_name, label_id, conversation_id', () => {
      expect(schema.properties.label_name).toBeDefined();
      expect(schema.properties.label_id).toBeDefined();
      expect(schema.properties.conversation_id).toBeDefined();
      expect(schema.required).not.toContain('label_name');
    });

    it('should validate add action with all params', () => {
      const tool = getToolByName('manage_labels')!;
      const result = tool.inputSchema.safeParse({
        action: 'add',
        label_name: 'Important',
        conversation_id: '123@c.us',
      });
      expect(result.success).toBe(true);
    });

    it('should validate create action', () => {
      const tool = getToolByName('manage_labels')!;
      const result = tool.inputSchema.safeParse({ action: 'create', label_name: 'New' });
      expect(result.success).toBe(true);
    });

    it('should reject invalid action', () => {
      const tool = getToolByName('manage_labels')!;
      const result = tool.inputSchema.safeParse({ action: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('should reject missing action', () => {
      const tool = getToolByName('manage_labels')!;
      const result = tool.inputSchema.safeParse({ label_name: 'Test' });
      expect(result.success).toBe(false);
    });
  });

  describe('manage_notes tool schema', () => {
    let schema: Record<string, any>;

    beforeAll(() => {
      schema = getToolsForMCP().find((t) => t.name === 'manage_notes')!.inputSchema;
    });

    it('should require action and contact_id', () => {
      expect(schema.required).toContain('action');
      expect(schema.required).toContain('contact_id');
    });

    it('should have action enum with get and set', () => {
      expect(schema.properties.action.enum).toEqual(['get', 'set']);
    });

    it('should have optional note param', () => {
      expect(schema.properties.note).toBeDefined();
      expect(schema.required).not.toContain('note');
    });

    it('should validate get action', () => {
      const tool = getToolByName('manage_notes')!;
      const result = tool.inputSchema.safeParse({ action: 'get', contact_id: '123@c.us' });
      expect(result.success).toBe(true);
    });

    it('should validate set action with note', () => {
      const tool = getToolByName('manage_notes')!;
      const result = tool.inputSchema.safeParse({
        action: 'set',
        contact_id: '123@c.us',
        note: 'Important client',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing contact_id', () => {
      const tool = getToolByName('manage_notes')!;
      const result = tool.inputSchema.safeParse({ action: 'get' });
      expect(result.success).toBe(false);
    });
  });

  describe('download_media tool schema', () => {
    it('should require message_id and conversation_id', () => {
      const schema = getToolsForMCP().find((t) => t.name === 'download_media')!.inputSchema;
      expect(schema.required).toContain('message_id');
      expect(schema.required).toContain('conversation_id');
    });

    it('should validate valid params', () => {
      const tool = getToolByName('download_media')!;
      const result = tool.inputSchema.safeParse({
        message_id: 'true_123@c.us_3EB0ABC',
        conversation_id: '123@c.us',
      });
      expect(result.success).toBe(true);
    });

    it('should accept optional target_session', () => {
      const tool = getToolByName('download_media')!;
      const result = tool.inputSchema.safeParse({
        message_id: 'true_123@c.us_3EB0ABC',
        conversation_id: '123@c.us',
        target_session: 'sess_abc123',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing message_id', () => {
      const tool = getToolByName('download_media')!;
      const result = tool.inputSchema.safeParse({ conversation_id: '123@c.us' });
      expect(result.success).toBe(false);
    });

    it('should reject missing conversation_id', () => {
      const tool = getToolByName('download_media')!;
      const result = tool.inputSchema.safeParse({ message_id: 'abc' });
      expect(result.success).toBe(false);
    });
  });

  describe('zodToJsonSchema conversion', () => {
    it('should handle all zod types used in tools', () => {
      const mcpTools = getToolsForMCP();
      for (const tool of mcpTools) {
        const props = tool.inputSchema.properties as Record<string, any>;
        for (const [key, prop] of Object.entries(props)) {
          // Properties use either `type` (simple) or `oneOf` (union)
          const hasType = prop.type !== undefined;
          const hasOneOf = prop.oneOf !== undefined;
          expect(hasType || hasOneOf).toBe(true);
          if (hasType) {
            expect(['string', 'number', 'boolean', 'object', 'array'].includes(prop.type)).toBe(true);
          }
        }
      }
    });

    it('should include descriptions on schema properties', () => {
      const mcpTools = getToolsForMCP();
      const query = mcpTools.find((t) => t.name === 'query')!;
      const props = query.inputSchema.properties as Record<string, any>;

      // All query props should have descriptions
      for (const [key, prop] of Object.entries(props)) {
        expect(prop.description || prop.enum).toBeDefined();
      }
    });
  });
});
