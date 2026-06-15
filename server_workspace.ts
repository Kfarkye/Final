import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

// --- Validation Helpers ---

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertNoHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} must not contain CR or LF characters`);
  }
}

function validateBasicEmail(value: string): void {
  assertNoHeaderInjection(value, 'to');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error('to must be a valid email address');
  }
}

function validateIsoDateRange(startIso: string, endIso: string): void {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime())) throw new Error('startIso must be a valid ISO 8601 datetime');
  if (Number.isNaN(end.getTime())) throw new Error('endIso must be a valid ISO 8601 datetime');
  if (end <= start) throw new Error('endIso must be after startIso');
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function getHeader(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string | undefined {
  return headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number = 15000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseResponse(res: Response): Promise<any> {
  const text = await res.text();
  let data: any = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) {
    return { error: true, status: res.status, statusText: res.statusText, details: data };
  }
  return data;
}

// --- Tool Declarations ---

export const workspaceDecls: FunctionDeclaration[] = [
  {
    name: "searchDrive",
    description: "Search Google Drive for files using Drive API query syntax",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING }
      },
      required: ["query"]
    }
  },
  {
    name: "sendEmail",
    description: "Send an email. Requires explicit user confirmation before execution.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING },
        subject: { type: Type.STRING },
        body: { type: Type.STRING }
      },
      required: ["to", "subject", "body"]
    }
  },
  {
    name: "createEvent",
    description: "Create a Google Calendar event. Requires explicit user confirmation before execution.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        startIso: { type: Type.STRING },
        endIso: { type: Type.STRING }
      },
      required: ["summary", "startIso", "endIso"]
    }
  },
  {
    name: "readGoogleDoc",
    description: "Read the plaintext content of a native Google Docs document by its document ID",
    parameters: {
      type: Type.OBJECT,
      properties: {
        documentId: { type: Type.STRING }
      },
      required: ["documentId"]
    }
  },
  {
    name: "searchEmail",
    description: "Search the user's Gmail using Gmail search query syntax",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING }
      },
      required: ["query"]
    }
  }
];

// --- Tool Executor ---

export async function executeWorkspaceTool(call: any, token: string) {
  const { name, args } = call;

  try {
    if (!token || typeof token !== 'string') {
      return { error: 'Google Workspace token is missing or invalid.' };
    }

    // --- searchDrive ---
    if (name === "searchDrive") {
      const query = requireString(args?.query, 'query');
      // Escape single quotes in user query to prevent Drive query injection
      const safeQuery = query.replace(/'/g, "\\'");
      const q = encodeURIComponent(`name contains '${safeQuery}'`);
      const fields = encodeURIComponent('files(id,name,mimeType,webViewLink,modifiedTime),nextPageToken');

      const res = await fetchWithTimeout(
        `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=5&fields=${fields}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return await parseResponse(res);
    }

    // --- sendEmail ---
    if (name === "sendEmail") {
      const to = requireString(args?.to, 'to');
      const subject = requireString(args?.subject, 'subject');
      const body = requireString(args?.body, 'body');

      // Prevent header injection
      validateBasicEmail(to);
      assertNoHeaderInjection(subject, 'subject');

      // RFC-compliant CRLF line endings + RFC 2047 encoded subject for non-ASCII
      const encodedSubject = /[^\x20-\x7E]/.test(subject)
        ? `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`
        : subject;

      const rawMsg = [
        `To: ${to}`,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        `Subject: ${encodedSubject}`,
        '',
        body
      ].join('\r\n');

      const encodedMsg = base64UrlEncode(rawMsg);

      const res = await fetchWithTimeout(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ raw: encodedMsg })
        }
      );
      return await parseResponse(res);
    }

    // --- createEvent ---
    if (name === "createEvent") {
      const summary = requireString(args?.summary, 'summary');
      const startIso = requireString(args?.startIso, 'startIso');
      const endIso = requireString(args?.endIso, 'endIso');

      validateIsoDateRange(startIso, endIso);

      const res = await fetchWithTimeout(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            summary,
            start: { dateTime: startIso },
            end: { dateTime: endIso }
          })
        }
      );
      return await parseResponse(res);
    }

    // --- readGoogleDoc ---
    if (name === "readGoogleDoc") {
      const documentId = requireString(args?.documentId, 'documentId');
      const encodedId = encodeURIComponent(documentId);

      const res = await fetchWithTimeout(
        `https://docs.googleapis.com/v1/documents/${encodedId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await parseResponse(res);

      if (data?.error) return data;

      // Deep extraction: paragraphs + tables
      let text = '';
      function extractContent(elements: any[]) {
        if (!Array.isArray(elements)) return;
        for (const el of elements) {
          if (el.paragraph?.elements) {
            for (const elem of el.paragraph.elements) {
              if (elem.textRun?.content) text += elem.textRun.content;
            }
          }
          if (el.table?.tableRows) {
            for (const row of el.table.tableRows) {
              if (!row.tableCells) continue;
              for (const cell of row.tableCells) {
                if (cell.content) extractContent(cell.content);
              }
            }
          }
        }
      }

      if (data.body?.content) extractContent(data.body.content);

      return { content: text || 'Empty or could not parse.' };
    }

    // --- searchEmail ---
    if (name === "searchEmail") {
      const query = requireString(args?.query, 'query');
      const q = encodeURIComponent(query);

      const res = await fetchWithTimeout(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await parseResponse(res);

      if (data?.error) return data;
      if (!Array.isArray(data.messages)) return { messages: [] };

      // Use metadata format to reduce payload size
      const detailedEmails = await Promise.all(data.messages.map(async (m: any) => {
        const messageId = requireString(m.id, 'message id');
        const dRes = await fetchWithTimeout(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const emailData = await parseResponse(dRes);
        if (emailData?.error) return { id: messageId, error: emailData };

        return {
          id: emailData.id,
          snippet: emailData.snippet,
          subject: getHeader(emailData.payload?.headers, 'Subject'),
          from: getHeader(emailData.payload?.headers, 'From'),
          date: getHeader(emailData.payload?.headers, 'Date')
        };
      }));

      return { messages: detailedEmails };
    }

    return { error: `Unknown tool: ${String(name)}` };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
