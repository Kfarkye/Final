import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { PDFParse } from 'pdf-parse';
import { parse as parseCsv } from 'csv-parse/sync';
// @ts-ignore
import mammoth from 'mammoth';

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
    name: "readDriveFile",
    description: "Reads any file from Google Drive — Docs, Sheets, Slides, PDFs, Office files, images, CSVs — and returns normalized text content. Automatically detects file type and routes to the appropriate parser. Supports both native Google Workspace files and uploaded binary files.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        fileId: { type: Type.STRING },
        mimeTypeHint: { type: Type.STRING },
        sheetName: { type: Type.STRING },
        sheetRange: { type: Type.STRING },
        pageRange: { type: Type.STRING },
        maxChars: { type: Type.INTEGER },
        outputFormat: { type: Type.STRING }
      },
      required: ["fileId"]
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

    // --- readDriveFile ---
    if (name === "readDriveFile") {
      let fileId = requireString(args?.fileId, 'fileId');
      const maxChars = typeof args?.maxChars === 'number' ? args.maxChars : 50000;
      const outputFormat = typeof args?.outputFormat === 'string' ? args.outputFormat : 'text';

      // Step 1: RESOLVE INPUT
      try {
        if (fileId.startsWith('data:')) {
          const base64Data = fileId.split(',')[1];
          if (base64Data) {
            const decoded = Buffer.from(base64Data, 'base64').toString('utf-8');
            const parsed = JSON.parse(decoded);
            if (parsed.id) {
              fileId = parsed.id;
            }
          }
        } else if (fileId.includes('drive.google.com') || fileId.includes('docs.google.com')) {
          const match = fileId.match(/[-\w]{25,}/);
          if (match) {
            fileId = match[0];
          }
        }
      } catch (e) {
        // Fallback to using fileId as-is
      }

      const encodedId = encodeURIComponent(fileId);

      // Step 2: GET METADATA
      const metaRes = await fetchWithTimeout(
        `https://www.googleapis.com/drive/v3/files/${encodedId}?fields=id,name,mimeType,size,owners,modifiedTime`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      if (metaRes.status === 404) {
        return { success: false, error: { code: 'FILE_NOT_FOUND', message: 'File not found' } };
      }
      if (metaRes.status === 403) {
        return { success: false, error: { code: 'PERMISSION_DENIED', message: 'Permission denied' } };
      }
      
      const meta = await parseResponse(metaRes);
      if (meta?.error) {
        return { success: false, error: { code: 'DRIVE_API_ERROR', message: meta.error } };
      }

      const mimeType = meta.mimeType;
      const sizeBytes = parseInt(meta.size || '0', 10);
      const fileName = meta.name || 'Unknown';

      // Step 3: SIZE CHECK
      if (sizeBytes > 50 * 1024 * 1024) {
        return { success: false, error: { code: 'FILE_TOO_LARGE', message: 'File exceeds 50MB' } };
      }

      let content = '';
      let mimeCategory = 'unknown';
      let tables: any[] = [];
      let pageCount = undefined;

      try {
        // Step 4: ROUTE BY MIME TYPE
        if (mimeType === 'application/vnd.google-apps.document') {
          mimeCategory = 'google_doc';
          const docRes = await fetchWithTimeout(
            `https://docs.googleapis.com/v1/documents/${encodedId}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const docData = await parseResponse(docRes);
          if (docData?.error) throw new Error('Docs API Error: ' + JSON.stringify(docData));

          const extractContent = (elements: any[]) => {
            if (!Array.isArray(elements)) return;
            for (const el of elements) {
              if (el.paragraph?.elements) {
                for (const elem of el.paragraph.elements) {
                  if (elem.textRun?.content) content += elem.textRun.content;
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
          if (docData.body?.content) extractContent(docData.body.content);
          
        } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
          mimeCategory = 'google_sheet';
          // Find the sheet name to query
          let ranges = args?.sheetRange ? `&ranges=${encodeURIComponent(args.sheetRange)}` : '';
          const sheetRes = await fetchWithTimeout(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodedId}?includeGridData=true${ranges}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const sheetData = await parseResponse(sheetRes);
          if (sheetData?.error) throw new Error('Sheets API Error: ' + JSON.stringify(sheetData));
          
          for (const sheet of sheetData.sheets || []) {
            if (args?.sheetName && sheet.properties.title !== args.sheetName) continue;
            
            const sheetTitle = sheet.properties.title;
            const gridData = sheet.data?.[0]?.rowData || [];
            
            const rows = gridData.map((row: any) => {
              return (row.values || []).map((cell: any) => cell.formattedValue || '');
            });
            
            const headers = rows.length > 0 ? rows[0] : [];
            const dataRows = rows.length > 1 ? rows.slice(1) : [];
            
            tables.push({
              sheetName: sheetTitle,
              headers,
              rows: dataRows,
              rowCount: rows.length,
              columnCount: headers.length
            });
            
            content += `--- Sheet: ${sheetTitle} ---\n`;
            for (const row of rows) {
              content += row.join(' | ') + '\n';
            }
          }
        } else if (mimeType === 'application/pdf' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mimeType === 'text/csv') {
          // Download bytes
          const dlRes = await fetchWithTimeout(
            `https://www.googleapis.com/drive/v3/files/${encodedId}?alt=media`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!dlRes.ok) throw new Error('Download failed');
          
          const arrayBuffer = await dlRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          
          if (mimeType === 'application/pdf') {
            mimeCategory = 'pdf';
            const parser = new PDFParse(new Uint8Array(buffer));
            await (parser as any).load();
            const pdfData = await parser.getText();
            content = pdfData.text;
            pageCount = pdfData.total;
          } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            mimeCategory = 'office_doc';
            const mammothRes = outputFormat === 'markdown' 
              ? await mammoth.convertToHtml({ buffer })
              : await mammoth.extractRawText({ buffer });
            content = mammothRes.value;
          } else if (mimeType === 'text/csv') {
            mimeCategory = 'csv';
            const records = parseCsv(buffer, { skip_empty_lines: true });
            const headers = records.length > 0 ? records[0] : [];
            const dataRows = records.length > 1 ? records.slice(1) : [];
            tables.push({
              sheetName: fileName,
              headers,
              rows: dataRows,
              rowCount: records.length,
              columnCount: headers.length
            });
            for (const row of records) {
              content += row.join(' | ') + '\n';
            }
          }
        } else if (mimeType === 'text/plain') {
          mimeCategory = 'plain_text';
          const dlRes = await fetchWithTimeout(
            `https://www.googleapis.com/drive/v3/files/${encodedId}?alt=media`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          content = await dlRes.text();
        } else {
          return { success: false, error: { code: 'UNSUPPORTED_FORMAT', message: `MIME type not supported: ${mimeType}` } };
        }
      } catch (err: unknown) {
        return { 
          success: false, 
          error: { 
            code: 'PARSE_FAILED', 
            message: err instanceof Error ? err.message : String(err) 
          } 
        };
      }

      // Step 5: NORMALIZE OUTPUT
      const charsTotal = content.length;
      let truncated = false;
      if (content.length > maxChars) {
        content = content.substring(0, maxChars) + '\n...[TRUNCATED BY SYSTEM]...';
        truncated = true;
      }

      // Step 6: RETURN
      return {
        success: true,
        fileId: meta.id,
        fileName,
        mimeType,
        mimeCategory,
        content: content || 'Empty or could not parse.',
        tables: tables.length > 0 ? tables : undefined,
        metadata: {
          owner: meta.owners?.[0]?.emailAddress || 'Unknown',
          lastModified: meta.modifiedTime,
          size_bytes: sizeBytes,
          page_count: pageCount,
          truncated,
          chars_returned: content.length,
          chars_total: charsTotal
        }
      };
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
