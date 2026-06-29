import React, { useMemo } from 'react';
import { AssistantResponseSchema } from '../schemas/assistant';
import { DataSheet } from './DataSheet';
import { MimeRenderer } from './MimeRenderer';

interface AssistantBlockRendererProps {
  content: string;
}

export function AssistantBlockRenderer({ content }: AssistantBlockRendererProps) {
  const parsedResponse = useMemo(() => {
    try {
      const parsed = JSON.parse(content);
      const result = AssistantResponseSchema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
      return null;
    } catch (e) {
      return null;
    }
  }, [content]);

  // Fallback to MimeRenderer if not valid JSON or while streaming partial JSON
  if (!parsedResponse) {
    return <MimeRenderer content={content} />;
  }

  return (
    <div className="flex flex-col gap-4 w-full">
      {parsedResponse.blocks.map((block, index) => {
        if (block.type === 'markdown') {
          return <MimeRenderer key={index} content={block.content} />;
        } else if (block.type === 'table') {
          return (
            <div key={index}>
              <DataSheet block={block} />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
