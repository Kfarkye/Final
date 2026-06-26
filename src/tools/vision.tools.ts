import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { GoogleAuth } from 'google-auth-library';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

async function getToken(): Promise<string> {
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token || '';
}

export const visionTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  ANALYZE IMAGE — OCR, labels, text from a URL
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "analyze_image",
      description: `Analyze an image using Cloud Vision AI. Supports:
- TEXT_DETECTION: Read text/numbers from screenshots, betting slips, scoreboards
- LABEL_DETECTION: Identify objects, scenes, activities
- LOGO_DETECTION: Identify team/brand logos
- WEB_DETECTION: Find related web content

Input: image URL or base64 data. Returns extracted text, labels, logos, and web matches.`,
      schema: z.object({
        imageUrl: z.string().optional().describe("Public URL of the image to analyze"),
        imageBase64: z.string().optional().describe("Base64-encoded image data (if no URL)"),
        features: z.array(z.enum([
          'TEXT_DETECTION', 'LABEL_DETECTION', 'LOGO_DETECTION',
          'WEB_DETECTION', 'FACE_DETECTION', 'OBJECT_LOCALIZATION',
          'DOCUMENT_TEXT_DETECTION'
        ])).default(['TEXT_DETECTION', 'LABEL_DETECTION']).describe("Analysis features to run"),
      })
    },
    handler: async (args) => {
      if (!args.imageUrl && !args.imageBase64) {
        return { error: "Provide either imageUrl or imageBase64." };
      }

      const token = await getToken();
      const image: any = args.imageUrl
        ? { source: { imageUri: args.imageUrl } }
        : { content: args.imageBase64 };

      const features = (args.features || ['TEXT_DETECTION', 'LABEL_DETECTION']).map(
        (type: string) => ({ type, maxResults: 10 })
      );

      try {
        const res = await fetch('https://vision.googleapis.com/v1/images:annotate', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ image, features }] }),
        });

        if (!res.ok) return { error: `Vision API error (${res.status}): ${await res.text()}` };

        const data: any = await res.json();
        const response = data.responses?.[0];
        if (response?.error) return { error: response.error.message };

        const result: any = {};

        // Text
        if (response.textAnnotations?.length) {
          result.fullText = response.textAnnotations[0].description;
          result.textBlocks = response.textAnnotations.slice(1, 11).map((t: any) => t.description);
        }
        if (response.fullTextAnnotation) {
          result.documentText = response.fullTextAnnotation.text;
        }

        // Labels
        if (response.labelAnnotations?.length) {
          result.labels = response.labelAnnotations.map((l: any) => ({
            label: l.description,
            confidence: Math.round(l.score * 100) + '%',
          }));
        }

        // Logos
        if (response.logoAnnotations?.length) {
          result.logos = response.logoAnnotations.map((l: any) => ({
            name: l.description,
            confidence: Math.round(l.score * 100) + '%',
          }));
        }

        // Web detection
        if (response.webDetection) {
          const wd = response.webDetection;
          result.webEntities = wd.webEntities?.slice(0, 5).map((e: any) => ({
            name: e.description,
            score: e.score,
          }));
          result.relatedPages = wd.pagesWithMatchingImages?.slice(0, 3).map((p: any) => ({
            title: p.pageTitle,
            url: p.url,
          }));
        }

        // Objects
        if (response.localizedObjectAnnotations?.length) {
          result.objects = response.localizedObjectAnnotations.map((o: any) => ({
            name: o.name,
            confidence: Math.round(o.score * 100) + '%',
          }));
        }

        return result;
      } catch (err: any) {
        return { error: `Vision analysis failed: ${err.message}` };
      }
    }
  },
];
