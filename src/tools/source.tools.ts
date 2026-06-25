/**
 * TRUTH PLATFORM — Source Inspection Tools
 *
 * Tools that let the in-app AI read and search its own source code
 * via the /api/source/* endpoints. This is how the AI "sees" the
 * codebase it's running on — no GitHub, no filesystem, no human
 * intervention needed.
 */

import { z } from 'zod';
import { RegisteredTool } from './types';
import { SOURCE_API_NONCE } from '../routes/source.routes';

const port = process.env.PORT || 8080;
// Force 127.0.0.1 to avoid DNS/IPv6/Egress issues. 
const SOURCE_API_BASE = `http://127.0.0.1:${port}/api/source`;
const INTERNAL_HEADERS = { 'x-source-nonce': SOURCE_API_NONCE };

export const sourceTools: RegisteredTool[] = [
  {
    definition: {
      name: 'read_source_file',
      description: 'Read a source file from this application\'s codebase. Use this to inspect, understand, or debug any file in the running service (e.g., src/routes/vault.routes.ts, lib/enterprise-chat-handler.ts, server.ts). This reads directly from the deployed container.',
      schema: z.object({
        path: z.string().describe('Relative path to the file (e.g., "src/routes/vault.routes.ts", "server.ts", "lib/enterprise-chat-handler.ts")')
      })
    },
    handler: async (args: any) => {
      try {
        const res = await fetch(`${SOURCE_API_BASE}/read?path=${encodeURIComponent(args.path)}`, { headers: INTERNAL_HEADERS });
        const data = await res.json();
        if (!res.ok) return { error: data.error || `Failed to read ${args.path}` };
        return data;
      } catch (err: any) {
        return { error: `Source read failed: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: 'list_source_directory',
      description: 'List the contents of a directory in this application\'s source tree. Use this to explore the codebase structure (e.g., "src/routes", "src/tools", "lib").',
      schema: z.object({
        path: z.string().default('.').describe('Relative directory path (e.g., "src/routes", "src/tools", "lib"). Default: root')
      })
    },
    handler: async (args: any) => {
      try {
        const res = await fetch(`${SOURCE_API_BASE}/tree?path=${encodeURIComponent(args.path || '.')}`, { headers: INTERNAL_HEADERS });
        const data = await res.json();
        if (!res.ok) return { error: data.error || `Failed to list ${args.path}` };
        return data;
      } catch (err: any) {
        return { error: `Source tree failed: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: 'search_source_code',
      description: 'Search for a text pattern across this application\'s source code. Returns matching files, line numbers, and line content. Use this to find where functions are defined, how things are wired, or trace bugs.',
      schema: z.object({
        query: z.string().describe('The text pattern to search for (e.g., "request_human_secret", "TruthMCPManager", "connectionId")'),
        path: z.string().default('.').describe('Directory to search within (e.g., "src", "lib"). Default: entire codebase')
      })
    },
    handler: async (args: any) => {
      try {
        const params = new URLSearchParams({ q: args.query });
        if (args.path) params.set('path', args.path);
        const res = await fetch(`${SOURCE_API_BASE}/search?${params}`, { headers: INTERNAL_HEADERS });
        const data = await res.json();
        if (!res.ok) return { error: data.error || `Search failed` };
        return data;
      } catch (err: any) {
        return { error: `Source search failed: ${err.message}` };
      }
    }
  }
];
