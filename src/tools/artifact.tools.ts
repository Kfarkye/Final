import { z } from "zod";
import { RegisteredTool, ToolContext } from "./types";
import { callGcpMcpTool } from "./gcp-mcp-client";
import { env } from "../config/env";
import { randomUUID } from "crypto";

// ============================================================================
// HTML5 Artifact Tools — First-Class Create, Preview, Deploy
// ============================================================================

const ARTIFACT_BUCKET = "clearspace-artifacts";
const ARTIFACT_PREFIX = "truth-artifacts";
const STORAGE_MCP = "https://storage.googleapis.com/storage/mcp";
const CLOUDRUN_MCP = "https://run.googleapis.com/mcp";

export const artifactTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "create_html_artifact",
      description: `Create an HTML5 artifact — a complete, self-contained web page. The HTML is saved to Cloud Storage and rendered inline as a live preview. Use this tool whenever you build a landing page, dashboard, form, visualization, reference doc, or any standalone HTML5 output. Return the FULL HTML including <!DOCTYPE html>, <head>, and <body>. Include all CSS and JS inline.`,
      schema: z.object({
        title: z.string().min(1, "Title is required"),
        html: z.string().min(10, "HTML content is required"),
        description: z.string().optional()
      })
    },
    handler: async (args) => {
      const artifactId = randomUUID().split("-")[0];
      const objectName = `${ARTIFACT_PREFIX}/${artifactId}.html`;
      const timestamp = new Date().toISOString();

      // Save to Cloud Storage via the GCP MCP tool
      try {
        await callGcpMcpTool(STORAGE_MCP, "write_text", {
          bucketName: ARTIFACT_BUCKET,
          objectName,
          textContent: args.html,
          projectId: env.GCP_PROJECT
        });
      } catch (err: any) {
        return {
          error: `Failed to save artifact to Cloud Storage: ${err.message}`,
          artifactId,
          fallback: "The HTML was generated but could not be persisted. It is still rendered inline below."
        };
      }

      // Build a base64 data URI for inline preview via MimeRenderer → SecureIframe
      const base64 = Buffer.from(args.html, "utf-8").toString("base64");
      const dataUri = `data:text/html;base64,${base64}`;

      return {
        artifactId,
        title: args.title,
        description: args.description || "",
        storageUrl: `gs://${ARTIFACT_BUCKET}/${objectName}`,
        previewUrl: `/api/artifacts/${artifactId}`,
        dataUri,
        timestamp,
        message: `HTML artifact "${args.title}" created and saved. Rendered inline below.`
      };
    }
  },
  {
    definition: {
      name: "deploy_html_artifact",
      description: "Deploy a previously created HTML artifact to Cloud Run as a live public website. Returns the public URL.",
      schema: z.object({
        artifactId: z.string().min(1, "Artifact ID is required"),
        serviceName: z.string().optional()
      })
    },
    handler: async (args) => {
      const objectName = `${ARTIFACT_PREFIX}/${args.artifactId}.html`;
      const serviceName = args.serviceName || `truth-page-${args.artifactId}`;

      // 1. Read the HTML from Cloud Storage
      let htmlContent: string;
      try {
        const result = await callGcpMcpTool(STORAGE_MCP, "read_text", {
          bucketName: ARTIFACT_BUCKET,
          objectName,
          projectId: env.GCP_PROJECT
        });
        htmlContent = typeof result === "string" ? result : (result?.content || result?.text || JSON.stringify(result));
      } catch (err: any) {
        return { error: `Failed to read artifact from Cloud Storage: ${err.message}` };
      }

      // 2. Deploy as a Cloud Run service from inline file contents
      try {
        const deployResult = await callGcpMcpTool(CLOUDRUN_MCP, "deploy_service_from_file_contents", {
          service: {
            name: serviceName,
            project: env.GCP_PROJECT,
            region: "us-central1",
            template: {
              containers: [{
                image: "node:22-slim",
                command: ["node", "server.js"],
                ports: [{ containerPort: 8080 }]
              }]
            },
            invokerIamDisabled: true,
            sourceCode: {
              sources: [
                {
                  filename: "index.html",
                  content: htmlContent
                },
                {
                  filename: "server.js",
                  content: `const http=require('http');const fs=require('fs');const html=fs.readFileSync('index.html','utf8');http.createServer((_,r)=>{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(html)}).listen(process.env.PORT||8080);`
                },
                {
                  filename: "Dockerfile",
                  content: `FROM node:22-slim\nWORKDIR /app\nCOPY . .\nEXPOSE 8080\nCMD ["node","server.js"]`
                }
              ]
            },
            baseImageUri: "node:22-slim"
          }
        });

        return {
          artifactId: args.artifactId,
          serviceName,
          deployResult,
          message: `Artifact deployed to Cloud Run as service "${serviceName}".`
        };
      } catch (err: any) {
        return { error: `Failed to deploy artifact: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "list_html_artifacts",
      description: "List all saved HTML artifacts from Cloud Storage.",
      schema: z.object({})
    },
    handler: async () => {
      try {
        const result = await callGcpMcpTool(STORAGE_MCP, "list_objects", {
          bucketName: ARTIFACT_BUCKET,
          prefix: `${ARTIFACT_PREFIX}/`,
          projectId: env.GCP_PROJECT
        });
        return result;
      } catch (err: any) {
        return { error: `Failed to list artifacts: ${err.message}` };
      }
    }
  }
];
