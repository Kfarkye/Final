import { z } from "zod";

export const ColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "number", "percent", "currency", "record"]).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  sticky: z.boolean().optional(),
  thresholds: z
    .object({
      high: z.number().optional(),
      low: z.number().optional()
    })
    .optional()
});

export const TableBlockSchema = z.object({
  type: z.literal("table"),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  columns: z.array(ColumnSchema),
  rows: z.array(z.record(z.any())),
  sort: z.object({
    key: z.string(),
    direction: z.enum(["asc", "desc"])
  }).optional(),
  sources: z
    .array(
      z.object({
        label: z.string(),
        url: z.string().url()
      })
    )
    .optional()
});

export const MarkdownBlockSchema = z.object({
  type: z.literal("markdown"),
  content: z.string()
});

export const AssistantBlockSchema = z.discriminatedUnion("type", [
  MarkdownBlockSchema,
  TableBlockSchema
]);

export const AssistantResponseSchema = z.object({
  blocks: z.array(AssistantBlockSchema)
});

// Types
export type Column = z.infer<typeof ColumnSchema>;
export type TableBlock = z.infer<typeof TableBlockSchema>;
export type MarkdownBlock = z.infer<typeof MarkdownBlockSchema>;
export type AssistantBlock = z.infer<typeof AssistantBlockSchema>;
export type AssistantResponse = z.infer<typeof AssistantResponseSchema>;
