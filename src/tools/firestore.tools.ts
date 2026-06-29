import { z } from 'zod';
import { RegisteredTool } from './types.js';
import * as admin from 'firebase-admin';
import { sseManager } from '../../lib/sse/sse-manager.js';
import { waitForApproval } from '../utils/approval.js';
import { env } from '../config/env.js';

let db: admin.firestore.Firestore | null = null;
function getFirestoreClient() {
  if (!db) {
    if (!admin.apps.length) {
      admin.initializeApp({
        projectId: env.GCP_PROJECT || 'reverie'
      });
    }
    // Using default database. If they specified a different database ID (e.g. ai-studio-...), 
    // we use the default for general tooling or allow passing it. 
    // The frontend uses ai-studio-73e9ce7f-7347-4837-a758-ccae784691f2, we'll try to use that if needed, 
    // but the admin SDK default is often sufficient unless multiple DBs exist.
    db = admin.firestore();
    try {
        db.settings({ databaseId: 'ai-studio-73e9ce7f-7347-4837-a758-ccae784691f2' });
    } catch (e) {
        // Ignore if already initialized or not supported in this version
    }
  }
  return db;
}

export const firestoreTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "get_firestore_document",
      description: "Read a specific document from Firestore by its path (e.g. 'users/123').",
      schema: z.object({
        path: z.string().describe("The document path, e.g. 'users/123' or 'conversations/abc'"),
      })
    },
    handler: async (args) => {
      try {
        const client = getFirestoreClient();
        const docRef = client.doc(args.path);
        const docSnap = await docRef.get();
        if (!docSnap.exists) {
          return { error: `Document not found at path: ${args.path}` };
        }
        return {
          path: args.path,
          id: docSnap.id,
          data: docSnap.data()
        };
      } catch (err: any) {
        return { error: `Firestore read failed: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "query_firestore_collection",
      description: "Query a Firestore collection. Supports basic equality filters.",
      schema: z.object({
        path: z.string().describe("The collection path, e.g. 'users'"),
        limit: z.number().optional().default(10).describe("Max documents to return"),
        whereField: z.string().optional().describe("Field to filter on"),
        whereOperator: z.enum(['==', '<', '<=', '>', '>=', '!=', 'array-contains', 'array-contains-any', 'in', 'not-in']).optional(),
        whereValue: z.string().optional().describe("Value to filter against (will be treated as string)"),
      })
    },
    handler: async (args) => {
      try {
        const client = getFirestoreClient();
        let query: admin.firestore.Query = client.collection(args.path);
        
        if (args.whereField && args.whereOperator && args.whereValue !== undefined) {
           query = query.where(args.whereField, args.whereOperator, args.whereValue);
        }
        
        if (args.limit) {
           query = query.limit(args.limit);
        }

        const snapshot = await query.get();
        return {
          path: args.path,
          count: snapshot.size,
          documents: snapshot.docs.map(d => ({
            id: d.id,
            data: d.data()
          }))
        };
      } catch (err: any) {
        return { error: `Firestore query failed: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "set_firestore_document",
      description: "Create or overwrite a Firestore document. Requires human approval.",
      schema: z.object({
        path: z.string().describe("The document path, e.g. 'users/123'"),
        data: z.record(z.any()).describe("The JSON object to write"),
        merge: z.boolean().default(true).describe("If true, merges with existing document. If false, overwrites completely.")
      })
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "set_firestore_document",
          args: { path: args.path, data: JSON.stringify(args.data) }
        });
        const approved = await waitForApproval(approvalId, "set_firestore_document", args);
        if (!approved) return { error: "Permission Denied: User did not approve writing to Firestore." };
      }

      try {
        const client = getFirestoreClient();
        await client.doc(args.path).set(args.data, { merge: args.merge });
        return { success: true, message: `Document ${args.path} written successfully.` };
      } catch (err: any) {
        return { error: `Firestore write failed: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "delete_firestore_document",
      description: "Delete a Firestore document. Requires human approval.",
      schema: z.object({
        path: z.string().describe("The document path to delete, e.g. 'users/123'"),
      })
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "delete_firestore_document",
          args: { path: args.path }
        });
        const approved = await waitForApproval(approvalId, "delete_firestore_document", args);
        if (!approved) return { error: "Permission Denied: User did not approve deletion." };
      }

      try {
        const client = getFirestoreClient();
        await client.doc(args.path).delete();
        return { success: true, message: `Document ${args.path} deleted successfully.` };
      } catch (err: any) {
        return { error: `Firestore delete failed: ${err.message}` };
      }
    }
  }
];
