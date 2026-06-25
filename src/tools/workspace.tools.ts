import { z } from 'zod';
import { RegisteredTool } from './types';
import { traceContext } from '../utils/logger';
import { withRetry, getCircuitBreaker, UpstreamError } from '../utils/resilience';

const workspaceBreaker = getCircuitBreaker("GoogleWorkspace");

async function fetchWithTrace(url: string, options: RequestInit = {}): Promise<Response> {
  const store = traceContext.getStore();
  const currentTraceId = store?.traceId || "no-trace-id";

  const headers = {
    ...options.headers,
    "X-Correlation-ID": currentTraceId,
    "X-Request-ID": currentTraceId
  } as Record<string, string>;

  return await workspaceBreaker.fire(async () => {
    return await withRetry("WorkspaceAPI", async () => {
      const res = await fetch(url, { ...options, headers });
      if (!res.ok) {
        const retryAfter = res.headers.get("retry-after");
        throw new UpstreamError(`Google API Error: ${res.statusText}`, res.status, retryAfter ? parseInt(retryAfter) : undefined);
      }
      return res;
    });
  }) as Response;
}

// Loose schemas for API response validation with passthrough
const DriveFileSchema = z.object({
  id: z.string()
}).passthrough();

const GmailThreadResponseSchema = z.object({
  id: z.string()
}).passthrough();

export const workspaceTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "search_drive",
      description: "Queries file names, types, content metadata, and date ranges inside Google Drive.",
      schema: z.object({
        query: z.string().min(1, "Query is required"),
        limit: z.number().int().optional()
      })
    },
    handler: async (args, context) => {
      const { googleAccessToken } = context;
      if (!googleAccessToken) {
        return { error: "Google Workspace token is missing. Please authorize Workspace first." };
      }
      const q = encodeURIComponent(`name contains '${args.query}'`);
      const res = await fetchWithTrace(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=${args.limit || 5}`, {
        headers: { Authorization: `Bearer ${googleAccessToken}` }
      });
      const data = await res.json();
      return z.object({ files: z.array(DriveFileSchema).optional() }).passthrough().parse(data);
    }
  },
  {
    definition: {
      name: "read_drive_file",
      description: "Extracts full content of Google Docs, spreadsheet schemas, or text-based documents.",
      schema: z.object({
        fileId: z.string().min(1, "File ID is required")
      })
    },
    handler: async (args, context) => {
      const { googleAccessToken } = context;
      if (!googleAccessToken) {
        return { error: "Google Workspace token is missing. Please authorize Workspace first." };
      }
      const res = await fetchWithTrace(`https://www.googleapis.com/drive/v3/files/${args.fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${googleAccessToken}` }
      });
      if (res.status === 400 || res.status === 403) {
        // Doc files require exporting
        const exportRes = await fetchWithTrace(`https://www.googleapis.com/drive/v3/files/${args.fileId}/export?mimeType=text/plain`, {
          headers: { Authorization: `Bearer ${googleAccessToken}` }
        });
        if (exportRes.ok) return { content: await exportRes.text() };
      }
      if (res.ok) return { content: await res.text() };
      return { error: `File retrieve failed (status ${res.status})` };
    }
  },
  {
    definition: {
      name: "create_drive_file",
      description: "Creates a clean document, file, or folder in Google Drive with the specified name and content.",
      schema: z.object({
        name: z.string().min(1, "Name is required"),
        content: z.string(),
        mimeType: z.string().optional()
      })
    },
    handler: async (args, context) => {
      const { googleAccessToken } = context;
      if (!googleAccessToken) {
        return { error: "Google Workspace token is missing. Please authorize Workspace first." };
      }
      const mime = args.mimeType || 'text/plain';
      const metadata = { name: args.name, mimeType: mime };

      // Use multipart upload to send metadata + content in a single request
      const boundary = '-------DriveUpload' + Date.now();
      const delimiter = '\r\n--' + boundary + '\r\n';
      const closeDelim = '\r\n--' + boundary + '--';

      const multipartBody =
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        'Content-Type: ' + mime + '\r\n\r\n' +
        args.content +
        closeDelim;

      const res = await fetchWithTrace(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,webContentLink',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${googleAccessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
          },
          body: multipartBody
        }
      );
      const fileData: any = await res.json();
      if (fileData.error) {
        return { error: `Drive upload failed: ${fileData.error.message || JSON.stringify(fileData.error)}` };
      }
      const parsedFile = DriveFileSchema.parse(fileData);
      return { success: true, file: parsedFile, webViewLink: fileData.webViewLink || null };
    }
  },
  {
    definition: {
      name: "list_unread_emails",
      description: "Lists the latest unread Gmail threads from your primary inbox.",
      schema: z.object({
        limit: z.number().int().optional()
      })
    },
    handler: async (args, context) => {
      const { googleAccessToken } = context;
      if (!googleAccessToken) {
        return { error: "Google Workspace token is missing. Please authorize Workspace first." };
      }
      const res = await fetchWithTrace(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=${args.limit || 5}`, {
        headers: { Authorization: `Bearer ${googleAccessToken}` }
      });
      const data: any = await res.json();
      if (!data.messages) return { threads: [] };
      const threads = await Promise.all(data.messages.map(async (m: any) => {
        const mRes = await fetchWithTrace(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
          headers: { Authorization: `Bearer ${googleAccessToken}` }
        });
        const mData: any = await mRes.json();
        const parsedMessage = z.object({ id: z.string() }).passthrough().parse(mData) as any;
        return {
          id: parsedMessage.id,
          snippet: parsedMessage.snippet,
          subject: parsedMessage.payload?.headers?.find((h: any) => h.name === 'Subject')?.value || 'No Subject',
          from: parsedMessage.payload?.headers?.find((h: any) => h.name === 'From')?.value || 'Unknown Sender'
        };
      }));
      return { threads };
    }
  },
  {
    definition: {
      name: "get_email_thread",
      description: "Retrieves a specific Gmail thread.",
      schema: z.object({
        threadId: z.string().min(1, "Thread ID is required")
      })
    },
    handler: async (args, context) => {
      const { googleAccessToken } = context;
      if (!googleAccessToken) {
        return { error: "Google Workspace token is missing. Please authorize Workspace first." };
      }
      const res = await fetchWithTrace(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${args.threadId}`, {
        headers: { Authorization: `Bearer ${googleAccessToken}` }
      });
      const data = await res.json();
      return GmailThreadResponseSchema.parse(data);
    }
  },
  {
    definition: {
      name: "send_email_draft",
      description: "Sends a formatted email with optional subject, recipients, and custom text sections.",
      schema: z.object({
        to: z.string().email("Invalid email format"),
        subject: z.string().min(1, "Subject is required"),
        body: z.string()
      })
    },
    handler: async (args, context) => {
      const { googleAccessToken } = context;
      if (!googleAccessToken) {
        return { error: "Google Workspace token is missing. Please authorize Workspace first." };
      }
      const rawMsg = [
        `To: ${args.to}`,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        `Subject: ${args.subject}`,
        '',
        args.body
      ].join('\n');
      
      const encodedMsg = Buffer.from(rawMsg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
      const res = await fetchWithTrace('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${googleAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ raw: encodedMsg })
      });
      const data = await res.json();
      return z.object({ id: z.string() }).passthrough().parse(data);
    }
  },
  {
    definition: {
      name: "get_upcoming_events",
      description: "Fetches calendar invite list, times, descriptions, and links from the main calendar.",
      schema: z.object({
        limit: z.number().int().optional()
      })
    },
    handler: async (args, context) => {
      const { googleAccessToken } = context;
      if (!googleAccessToken) {
        return { error: "Google Workspace token is missing. Please authorize Workspace first." };
      }
      const limit = args.limit || 5;
      const now = new Date().toISOString();
      const res = await fetchWithTrace(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=${limit}&orderBy=startTime&singleEvents=true&timeMin=${encodeURIComponent(now)}`, {
        headers: { Authorization: `Bearer ${googleAccessToken}` }
      });
      const data = await res.json();
      return z.object({ items: z.array(z.any()) }).passthrough().parse(data);
    }
  },
  {
    definition: {
      name: "create_calendar_event",
      description: "Creates a scheduled appointment or business meeting on your primary calendar.",
      schema: z.object({
        summary: z.string().min(1, "Summary is required"),
        startTime: z.string().min(1, "Start time is required"),
        endTime: z.string().min(1, "End time is required")
      })
    },
    handler: async (args, context) => {
      const { googleAccessToken } = context;
      if (!googleAccessToken) {
        return { error: "Google Workspace token is missing. Please authorize Workspace first." };
      }
      const res = await fetchWithTrace('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${googleAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          summary: args.summary,
          start: { dateTime: args.startTime },
          end: { dateTime: args.endTime }
        })
      });
      const data = await res.json();
      return z.object({ id: z.string() }).passthrough().parse(data);
    }
  },
  {
    definition: {
      name: "check_availability",
      description: "Queries free/busy ranges for specific sets of email invitees to optimize meeting schedules.",
      schema: z.object({
        emails: z.array(z.string().email("Invalid email format")),
        startTime: z.string().min(1, "Start time is required"),
        endTime: z.string().min(1, "End time is required")
      })
    },
    handler: async (args, context) => {
      const { googleAccessToken } = context;
      if (!googleAccessToken) {
        return { error: "Google Workspace token is missing. Please authorize Workspace first." };
      }
      const body = {
        timeMin: args.startTime,
        timeMax: args.endTime,
        items: args.emails.map((email: string) => ({ id: email }))
      };
      const res = await fetchWithTrace('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${googleAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      return z.object({ calendars: z.record(z.string(), z.any()) }).passthrough().parse(data);
    }
  }
];
