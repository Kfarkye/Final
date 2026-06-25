// src/tools/gke.tools.ts
// GKE-native tools — the AI manages its own infrastructure on Kubernetes
import { z } from 'zod';
import { RegisteredTool } from './types';
import { sseManager } from '../../lib/sse/sse-manager';
import { waitForApproval } from '../utils/approval';
import { env } from '../config/env';
import { GoogleAuth } from 'google-auth-library';
import { Logging } from '@google-cloud/logging';

const PROJECT = env.GCP_PROJECT;
const REGION = process.env.GCP_REGION || 'us-central1';
const CLUSTER = process.env.GKE_CLUSTER || 'truth-cluster';
const NAMESPACE = process.env.K8S_NAMESPACE || 'default';

// Cache cluster endpoint (doesn't change)
let _clusterEndpoint: string | null = null;

// Helper: get cluster endpoint via GKE REST API (no googleapis dep)
async function getClusterEndpoint(auth: GoogleAuth): Promise<string> {
  if (_clusterEndpoint) return _clusterEndpoint;
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const url = `https://container.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/clusters/${CLUSTER}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token.token}` },
  });
  const data = await res.json() as any;
  _clusterEndpoint = `https://${data.endpoint}`;
  return _clusterEndpoint;
}

// Helper: execute kubectl-equivalent via K8s API
async function getK8sClient() {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const endpoint = await getClusterEndpoint(auth);

  return {
    endpoint,
    token: token.token!,
  };
}

async function k8sRequest(path: string, method: string = 'GET', body?: any): Promise<any> {
  const { endpoint, token } = await getK8sClient();
  const url = `${endpoint}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export const gkeTools: RegisteredTool<any>[] = [

  // ════════════════════════════════════════════════════════════════════
  // POD INSPECTION
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_pods",
      description: "List all pods in the namespace with status, restarts, age, and image.",
      schema: z.object({
        namespace: z.string().default(NAMESPACE),
        labelSelector: z.string().optional().describe("Label selector (e.g. 'app=reverie')"),
      }),
    },
    handler: async (args) => {
      try {
        let path = `/api/v1/namespaces/${args.namespace}/pods`;
        if (args.labelSelector) path += `?labelSelector=${encodeURIComponent(args.labelSelector)}`;
        const result = await k8sRequest(path);
        return {
          pods: (result.items || []).map((pod: any) => ({
            name: pod.metadata.name,
            phase: pod.status.phase,
            ready: pod.status.containerStatuses?.[0]?.ready || false,
            restarts: pod.status.containerStatuses?.[0]?.restartCount || 0,
            image: pod.spec.containers?.[0]?.image,
            startTime: pod.status.startTime,
            node: pod.spec.nodeName,
          })),
        };
      } catch (err: any) {
        return { error: `Failed to list pods: ${err.message}` };
      }
    },
  },

  {
    definition: {
      name: "get_pod_logs",
      description: "Get recent logs from a pod. Use to debug startup failures or runtime errors.",
      schema: z.object({
        pod: z.string().min(1).describe("Pod name"),
        namespace: z.string().default(NAMESPACE),
        tailLines: z.number().int().positive().default(100),
        container: z.string().optional(),
      }),
    },
    handler: async (args) => {
      try {
        let path = `/api/v1/namespaces/${args.namespace}/pods/${args.pod}/log?tailLines=${args.tailLines}`;
        if (args.container) path += `&container=${args.container}`;
        const { endpoint, token } = await getK8sClient();
        const res = await fetch(`${endpoint}${path}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const text = await res.text();
        return { logs: text };
      } catch (err: any) {
        return { error: `Failed to get pod logs: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // DEPLOYMENT MANAGEMENT
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_deployments",
      description: "List all deployments with replica counts, images, and conditions.",
      schema: z.object({
        namespace: z.string().default(NAMESPACE),
      }),
    },
    handler: async (args) => {
      try {
        const result = await k8sRequest(`/apis/apps/v1/namespaces/${args.namespace}/deployments`);
        return {
          deployments: (result.items || []).map((d: any) => ({
            name: d.metadata.name,
            replicas: d.status.replicas || 0,
            readyReplicas: d.status.readyReplicas || 0,
            image: d.spec.template.spec.containers?.[0]?.image,
            conditions: (d.status.conditions || []).map((c: any) => ({
              type: c.type, status: c.status, reason: c.reason,
            })),
          })),
        };
      } catch (err: any) {
        return { error: `Failed to list deployments: ${err.message}` };
      }
    },
  },

  {
    definition: {
      name: "scale_deployment",
      description: "Scale a deployment to a specific replica count. Requires human approval.",
      schema: z.object({
        deployment: z.string().min(1),
        replicas: z.number().int().min(0).max(20),
        namespace: z.string().default(NAMESPACE),
      }),
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId, tool: "scale_deployment",
          args: { deployment: args.deployment, replicas: args.replicas },
        });
        const approved = await waitForApproval(approvalId, "scale_deployment", args);
        if (!approved) return { error: "Permission Denied: User did not approve scaling." };
      }

      try {
        const path = `/apis/apps/v1/namespaces/${args.namespace}/deployments/${args.deployment}/scale`;
        const result = await k8sRequest(path, 'PUT', {
          apiVersion: 'autoscaling/v1',
          kind: 'Scale',
          metadata: { name: args.deployment, namespace: args.namespace },
          spec: { replicas: args.replicas },
        });
        return { deployment: args.deployment, replicas: args.replicas, status: 'scaled' };
      } catch (err: any) {
        return { error: `Failed to scale: ${err.message}` };
      }
    },
  },

  {
    definition: {
      name: "rollout_restart",
      description: "Trigger a rolling restart of a deployment (picks up new secrets, config). Requires human approval.",
      schema: z.object({
        deployment: z.string().min(1),
        namespace: z.string().default(NAMESPACE),
      }),
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId, tool: "rollout_restart",
          args: { deployment: args.deployment },
        });
        const approved = await waitForApproval(approvalId, "rollout_restart", args);
        if (!approved) return { error: "Permission Denied: User did not approve restart." };
      }

      try {
        const path = `/apis/apps/v1/namespaces/${args.namespace}/deployments/${args.deployment}`;
        const now = new Date().toISOString();
        await k8sRequest(path, 'PATCH', {
          spec: {
            template: {
              metadata: {
                annotations: { 'kubectl.kubernetes.io/restartedAt': now },
              },
            },
          },
        });
        return { deployment: args.deployment, restartedAt: now, status: 'rolling' };
      } catch (err: any) {
        return { error: `Failed to restart: ${err.message}` };
      }
    },
  },

  {
    definition: {
      name: "set_deployment_image",
      description: "Update the container image on a deployment (triggers rolling update). Requires human approval.",
      schema: z.object({
        deployment: z.string().min(1),
        image: z.string().min(1).describe("Full image URI (e.g. us-central1-docker.pkg.dev/proj/repo/img:tag)"),
        namespace: z.string().default(NAMESPACE),
      }),
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId, tool: "set_deployment_image",
          args: { deployment: args.deployment, image: args.image },
        });
        const approved = await waitForApproval(approvalId, "set_deployment_image", args);
        if (!approved) return { error: "Permission Denied: User did not approve image update." };
      }

      try {
        const path = `/apis/apps/v1/namespaces/${args.namespace}/deployments/${args.deployment}`;
        const dep = await k8sRequest(path);
        dep.spec.template.spec.containers[0].image = args.image;
        await k8sRequest(path, 'PUT', dep);
        return { deployment: args.deployment, image: args.image, status: 'rolling_update' };
      } catch (err: any) {
        return { error: `Failed to update image: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // SERVICES & INGRESS
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_services",
      description: "List K8s services with type, cluster IP, and ports.",
      schema: z.object({ namespace: z.string().default(NAMESPACE) }),
    },
    handler: async (args) => {
      try {
        const result = await k8sRequest(`/api/v1/namespaces/${args.namespace}/services`);
        return {
          services: (result.items || []).map((s: any) => ({
            name: s.metadata.name,
            type: s.spec.type,
            clusterIP: s.spec.clusterIP,
            ports: s.spec.ports?.map((p: any) => ({ port: p.port, targetPort: p.targetPort, protocol: p.protocol })),
          })),
        };
      } catch (err: any) {
        return { error: `Failed to list services: ${err.message}` };
      }
    },
  },

  {
    definition: {
      name: "get_ingress",
      description: "Get ingress details including external IP, hosts, TLS cert status.",
      schema: z.object({
        name: z.string().default("reverie"),
        namespace: z.string().default(NAMESPACE),
      }),
    },
    handler: async (args) => {
      try {
        const result = await k8sRequest(`/apis/networking.k8s.io/v1/namespaces/${args.namespace}/ingresses/${args.name}`);
        return {
          name: result.metadata.name,
          hosts: result.spec.rules?.map((r: any) => r.host) || ['*'],
          addresses: result.status.loadBalancer?.ingress?.map((i: any) => i.ip) || [],
          annotations: result.metadata.annotations,
        };
      } catch (err: any) {
        return { error: `Failed to get ingress: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // SECRETS
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_k8s_secrets",
      description: "List K8s secrets in the namespace (names only, no values).",
      schema: z.object({ namespace: z.string().default(NAMESPACE) }),
    },
    handler: async (args) => {
      try {
        const result = await k8sRequest(`/api/v1/namespaces/${args.namespace}/secrets`);
        return {
          secrets: (result.items || []).map((s: any) => ({
            name: s.metadata.name,
            type: s.type,
            keys: Object.keys(s.data || {}),
          })),
        };
      } catch (err: any) {
        return { error: `Failed to list secrets: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // HPA & AUTOSCALING
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_hpa",
      description: "Get HorizontalPodAutoscaler status — current/target replicas, CPU utilization.",
      schema: z.object({
        name: z.string().default("reverie"),
        namespace: z.string().default(NAMESPACE),
      }),
    },
    handler: async (args) => {
      try {
        const result = await k8sRequest(`/apis/autoscaling/v2/namespaces/${args.namespace}/horizontalpodautoscalers/${args.name}`);
        return {
          name: result.metadata.name,
          minReplicas: result.spec.minReplicas,
          maxReplicas: result.spec.maxReplicas,
          currentReplicas: result.status.currentReplicas,
          desiredReplicas: result.status.desiredReplicas,
          conditions: (result.status.conditions || []).map((c: any) => ({
            type: c.type, status: c.status, reason: c.reason,
          })),
          currentMetrics: (result.status.currentMetrics || []).map((m: any) => ({
            type: m.type,
            current: m.resource?.current,
          })),
        };
      } catch (err: any) {
        return { error: `Failed to get HPA: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // GKE CLUSTER INFO
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_cluster_info",
      description: "Get GKE cluster details — version, node count, Autopilot mode, endpoint.",
      schema: z.object({}),
    },
    handler: async () => {
      try {
        const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const client = await auth.getClient();
        const token = await client.getAccessToken();
        const url = `https://container.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/clusters/${CLUSTER}`;
        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token.token}` },
        });
        const cluster = await res.json() as any;
        return {
          name: cluster.name,
          location: cluster.location,
          status: cluster.status,
          currentNodeCount: cluster.currentNodeCount,
          autopilot: cluster.autopilot?.enabled || false,
          masterVersion: cluster.currentMasterVersion,
          nodeVersion: cluster.currentNodeVersion,
          endpoint: cluster.endpoint,
          servicesIpv4Cidr: cluster.servicesIpv4Cidr,
        };
      } catch (err: any) {
        return { error: `Failed to get cluster info: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // GKE LOGS (replaces Cloud Run logs)
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "query_gke_logs",
      description: "Query recent logs for a GKE workload. Use to debug errors, check deployments, or inspect tool payloads.",
      schema: z.object({
        workload: z.string().default("reverie").describe("Deployment/pod name to filter"),
        textPayload: z.string().optional().describe("Search string in log payloads"),
        severity: z.enum(["INFO", "WARNING", "ERROR", "CRITICAL"]).optional(),
        limit: z.number().max(200).default(20),
      }),
    },
    handler: async (args) => {
      try {
        const logging = new Logging({ projectId: PROJECT });
        let filter = `resource.type="k8s_container" AND resource.labels.cluster_name="${CLUSTER}" AND resource.labels.namespace_name="${NAMESPACE}"`;
        if (args.workload) filter += ` AND resource.labels.container_name="${args.workload}"`;
        if (args.severity) filter += ` AND severity>=${args.severity}`;
        if (args.textPayload) filter += ` AND textPayload:"${args.textPayload}"`;

        const [entries] = await logging.getEntries({
          filter,
          pageSize: args.limit,
          orderBy: 'timestamp desc',
        });

        return { logs: entries.map((e: any) => e.toJSON()) };
      } catch (err: any) {
        return { error: `Failed to query GKE logs: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // MANAGED CERTIFICATE STATUS
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_cert_status",
      description: "Check the status of a Google-managed SSL certificate for the domain.",
      schema: z.object({
        name: z.string().default("truth-cert"),
        namespace: z.string().default(NAMESPACE),
      }),
    },
    handler: async (args) => {
      try {
        const result = await k8sRequest(`/apis/networking.gke.io/v1/namespaces/${args.namespace}/managedcertificates/${args.name}`);
        return {
          name: result.metadata.name,
          domains: result.spec.domains,
          certificateStatus: result.status?.certificateStatus,
          domainStatus: result.status?.domainStatus,
        };
      } catch (err: any) {
        return { error: `Failed to get cert status: ${err.message}` };
      }
    },
  },
];
