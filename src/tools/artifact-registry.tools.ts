// src/tools/artifact-registry.tools.ts
// Artifact Registry inspection tools — list images, tags, and digests
import { z } from 'zod';
import { RegisteredTool } from './types';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env';

const PROJECT = env.GCP_PROJECT;
const REGION = process.env.GCP_REGION || 'us-central1';
const DEFAULT_REPO = 'truth';

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function arRequest(path: string): Promise<any> {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const url = `https://artifactregistry.googleapis.com/v1/${path}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token.token}` },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Artifact Registry API ${res.status}: ${errText}`);
  }
  return res.json();
}

export const artifactRegistryTools: RegisteredTool<any>[] = [

  // ═══════════════════════════════════════════════════════════════════
  //  LIST IMAGES — Show all container images in an AR repository
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_ar_images",
      description: "List container images in an Artifact Registry Docker repository. Shows image names and URIs. Defaults to the 'truth' repository.",
      schema: z.object({
        repository: z.string().default(DEFAULT_REPO).describe("Artifact Registry repository name"),
        region: z.string().default(REGION).describe("GCP region"),
        pageSize: z.number().int().positive().default(20).describe("Max images to return"),
      })
    },
    handler: async (args) => {
      try {
        const parent = `projects/${PROJECT}/locations/${args.region}/repositories/${args.repository}`;
        const data = await arRequest(`${parent}/dockerImages?pageSize=${args.pageSize}`);
        return {
          repository: args.repository,
          region: args.region,
          count: (data.dockerImages || []).length,
          images: (data.dockerImages || []).map((img: any) => ({
            name: img.name?.split('/').pop(),
            fullName: img.name,
            uri: img.uri,
            tags: img.tags || [],
            mediaType: img.mediaType,
            imageSizeBytes: img.imageSizeBytes,
            uploadTime: img.uploadTime,
            buildTime: img.buildTime,
          })),
        };
      } catch (err: any) {
        return { error: `Failed to list AR images: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  LIST PACKAGES — Show packages (image names) in a repository
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_ar_packages",
      description: "List packages (image names) in an Artifact Registry repository. Use to discover what images exist before listing their tags.",
      schema: z.object({
        repository: z.string().default(DEFAULT_REPO).describe("Artifact Registry repository name"),
        region: z.string().default(REGION).describe("GCP region"),
      })
    },
    handler: async (args) => {
      try {
        const parent = `projects/${PROJECT}/locations/${args.region}/repositories/${args.repository}`;
        const data = await arRequest(`${parent}/packages`);
        return {
          repository: args.repository,
          count: (data.packages || []).length,
          packages: (data.packages || []).map((pkg: any) => ({
            name: pkg.name?.split('/').pop(),
            fullName: pkg.name,
            createTime: pkg.createTime,
            updateTime: pkg.updateTime,
          })),
        };
      } catch (err: any) {
        return { error: `Failed to list AR packages: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  LIST TAGS — Show tags/versions for a specific image
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_ar_tags",
      description: "List tags (versions) for a specific container image in Artifact Registry. Shows tag name, digest, and timestamps.",
      schema: z.object({
        packageName: z.string().min(1).describe("Package/image name (e.g. 'reverie')"),
        repository: z.string().default(DEFAULT_REPO).describe("Artifact Registry repository name"),
        region: z.string().default(REGION).describe("GCP region"),
        pageSize: z.number().int().positive().default(20).describe("Max tags to return"),
      })
    },
    handler: async (args) => {
      try {
        const parent = `projects/${PROJECT}/locations/${args.region}/repositories/${args.repository}/packages/${args.packageName}`;
        const data = await arRequest(`${parent}/tags?pageSize=${args.pageSize}`);
        return {
          package: args.packageName,
          repository: args.repository,
          count: (data.tags || []).length,
          tags: (data.tags || []).map((tag: any) => ({
            name: tag.name?.split('/').pop(),
            fullName: tag.name,
            version: tag.version?.split('/').pop(),
          })),
        };
      } catch (err: any) {
        return { error: `Failed to list AR tags: ${err.message}` };
      }
    }
  },
];
