import { z } from 'zod';
import { RegisteredTool } from './types.js';
import * as admin from 'firebase-admin';
import { env } from '../config/env.js';
import { sseManager } from '../../lib/sse/sse-manager.js';
import { waitForApproval } from '../utils/approval.js';

let appInstance: admin.app.App | null = null;
function getFirestoreClient(projectId?: string, databaseId?: string) {
  if (!appInstance && !admin.apps.length) {
    appInstance = admin.initializeApp({
      projectId: projectId || env.GCP_PROJECT || 'reverie'
    });
  } else if (!appInstance && admin.apps.length > 0) {
    appInstance = admin.apps[0];
  }
  
  // Try to use databaseId if provided
  try {
    if (databaseId) {
       return admin.firestore(appInstance!);
       // The Node.js admin SDK allows specifying databaseId in settings or initialization for newer versions, 
       // but typically we can just return admin.firestore(appInstance) and set settings if needed
    }
  } catch (e) {
    // Fallback
  }
  return admin.firestore(appInstance!);
}

export const firestoreTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "list_firestore_collections",
      description: "Lists root Firestore collections.",
      schema: z.object({
        projectId: z.string().optional(),
        databaseId: z.string().optional()
      })
    },
    handler: async (args) => {
      try {
        const client = getFirestoreClient(args.projectId, args.databaseId);
        const collections = await client.listCollections();
        return {
          projectId: args.projectId || env.GCP_PROJECT || 'reverie',
          databaseId: args.databaseId || '(default)',
          collections: collections.map(c => c.id)
        };
      } catch (err: any) {
        return { error: `Failed to list collections: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "get_firestore_document",
      description: "Gets a Firestore document.",
      schema: z.object({
        projectId: z.string().optional(),
        databaseId: z.string().optional(),
        path: z.string()
      })
    },
    handler: async (args) => {
      try {
        const client = getFirestoreClient(args.projectId, args.databaseId);
        const docRef = client.doc(args.path);
        const docSnap = await docRef.get();
        return {
          exists: docSnap.exists,
          projectId: args.projectId || env.GCP_PROJECT || 'reverie',
          databaseId: args.databaseId || '(default)',
          path: args.path,
          createTime: docSnap.createTime?.toDate().toISOString(),
          updateTime: docSnap.updateTime?.toDate().toISOString(),
          data: docSnap.data()
        };
      } catch (err: any) {
        return { exists: false, error: err.message };
      }
    }
  },
  {
    definition: {
      name: "query_firestore_collection",
      description: "Queries a Firestore collection.",
      schema: z.object({
        projectId: z.string().optional(),
        databaseId: z.string().optional(),
        collectionPath: z.string(),
        where: z.array(z.object({
          field: z.string(),
          op: z.string(),
          value: z.unknown()
        })).optional(),
        orderBy: z.array(z.object({
          field: z.string(),
          direction: z.string()
        })).optional(),
        limit: z.number().optional(),
        queryOptions: z.record(z.unknown()).optional()
      })
    },
    handler: async (args) => {
      try {
        const client = getFirestoreClient(args.projectId, args.databaseId);
        let query: admin.firestore.Query = client.collection(args.collectionPath);
        
        if (args.where) {
          for (const w of args.where) {
            query = query.where(w.field, w.op as admin.firestore.WhereFilterOp, w.value);
          }
        }
        
        if (args.orderBy) {
          for (const o of args.orderBy) {
            query = query.orderBy(o.field, o.direction as admin.firestore.OrderByDirection);
          }
        }
        
        if (args.limit) {
           query = query.limit(args.limit);
        }

        const snapshot = await query.get();
        return {
          projectId: args.projectId || env.GCP_PROJECT || 'reverie',
          databaseId: args.databaseId || '(default)',
          collectionPath: args.collectionPath,
          count: snapshot.size,
          documents: snapshot.docs.map(d => ({
            id: d.id,
            path: d.ref.path,
            createTime: d.createTime?.toDate().toISOString(),
            updateTime: d.updateTime?.toDate().toISOString(),
            data: d.data()
          }))
        };
      } catch (err: any) {
        return { error: `Query failed: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "set_firestore_document",
      description: "Creates or replaces a Firestore document.",
      schema: z.object({
        projectId: z.string().optional(),
        databaseId: z.string().optional(),
        path: z.string(),
        data: z.record(z.unknown()),
        merge: z.boolean().optional(),
        setOptions: z.record(z.unknown()).optional()
      })
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "set_firestore_document",
          args: { path: args.path }
        });
        const approved = await waitForApproval(approvalId, "set_firestore_document", args);
        if (!approved) return { ok: false, error: "Permission Denied" };
      }

      try {
        const client = getFirestoreClient(args.projectId, args.databaseId);
        const docRef = client.doc(args.path);
        const options = { merge: args.merge, ...args.setOptions };
        
        const res = await docRef.set(args.data, options);
        return {
          ok: true,
          projectId: args.projectId || env.GCP_PROJECT || 'reverie',
          databaseId: args.databaseId || '(default)',
          path: args.path,
          merge: args.merge,
          updateTime: res.writeTime?.toDate().toISOString(),
          data: args.data // Approximate returned data based on inputs
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    }
  },
  {
    definition: {
      name: "update_firestore_document",
      description: "Updates a Firestore document.",
      schema: z.object({
        projectId: z.string().optional(),
        databaseId: z.string().optional(),
        path: z.string(),
        patch: z.record(z.unknown()),
        precondition: z.object({
          updateTime: z.string().optional(),
          exists: z.boolean().optional()
        }).optional(),
        updateOptions: z.record(z.unknown()).optional()
      })
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "update_firestore_document",
          args: { path: args.path }
        });
        const approved = await waitForApproval(approvalId, "update_firestore_document", args);
        if (!approved) return { ok: false, error: "Permission Denied" };
      }

      try {
        const client = getFirestoreClient(args.projectId, args.databaseId);
        const docRef = client.doc(args.path);
        
        let precondition: any = undefined;
        if (args.precondition?.updateTime) precondition = { lastUpdateTime: admin.firestore.Timestamp.fromDate(new Date(args.precondition.updateTime)) };
        else if (args.precondition?.exists !== undefined) precondition = { exists: args.precondition.exists };
        
        let res;
        if (precondition) {
           res = await docRef.update(args.patch, precondition);
        } else {
           res = await docRef.update(args.patch);
        }
        
        return {
          ok: true,
          projectId: args.projectId || env.GCP_PROJECT || 'reverie',
          databaseId: args.databaseId || '(default)',
          path: args.path,
          updateTime: res.writeTime?.toDate().toISOString(),
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    }
  },
  {
    definition: {
      name: "delete_firestore_document",
      description: "Deletes a Firestore document.",
      schema: z.object({
        projectId: z.string().optional(),
        databaseId: z.string().optional(),
        path: z.string(),
        deleteOptions: z.record(z.unknown()).optional()
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
        if (!approved) return { ok: false, error: "Permission Denied" };
      }

      try {
        const client = getFirestoreClient(args.projectId, args.databaseId);
        const docRef = client.doc(args.path);
        
        await docRef.delete();
        return {
          ok: true,
          projectId: args.projectId || env.GCP_PROJECT || 'reverie',
          databaseId: args.databaseId || '(default)',
          path: args.path
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    }
  }
];
