import { useState, useCallback, DragEvent, ClipboardEvent, ChangeEvent } from 'react';
import { FileAttachment, UseFileAttachmentOptions } from './types';

// Helper utility to convert a browser File to a base64 Data URI asynchronously
const fileToDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Conversion to base64 format returned empty or invalid buffer.'));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
};

export function useFileAttachment(options: UseFileAttachmentOptions = {}) {
  const { maxFileSize, maxFiles = 10, acceptedTypes, onError } = options;
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    const filesArray = Array.from(fileList);

    // Limit check: Pre-calculate size limits
    if (attachments.length + filesArray.length > maxFiles) {
      onError?.({
        type: 'LIMIT_COUNT',
        message: `Maximum of ${maxFiles} concurrent files allowed.`,
      });
      return;
    }

    const processed: FileAttachment[] = [];

    for (const file of filesArray) {
      // Validation: Check File Type
      if (acceptedTypes && acceptedTypes.length > 0) {
        const isAccepted = acceptedTypes.some((type) => {
          if (type.endsWith('/*')) {
            const prefix = type.split('/')[0];
            return file.type.startsWith(prefix);
          }
          return file.type === type || file.name.endsWith(type);
        });

        if (!isAccepted) {
          onError?.({
            type: 'UNSUPPORTED_TYPE',
            message: `File format "${file.type || 'unknown'}" of "${file.name}" is not supported.`,
            fileName: file.name,
          });
          continue;
        }
      }

      // Validation: Check File Size
      if (maxFileSize && file.size > maxFileSize) {
        onError?.({
          type: 'LIMIT_SIZE',
          message: `File "${file.name}" exceeds the maximum limit of ${(maxFileSize / (1024 * 1024)).toFixed(1)}MB.`,
          fileName: file.name,
        });
        continue;
      }

      try {
        const dataUrl = await fileToDataUrl(file);
        processed.push({
          id: `${file.name}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          file,
          name: file.name,
          size: file.size,
          type: file.type,
          dataUrl,
        });
      } catch (err) {
        onError?.({
          type: 'READ_ERROR',
          message: `Could not parse and read contents of "${file.name}".`,
          fileName: file.name,
        });
      }
    }

    if (processed.length > 0) {
      setAttachments((prev) => [...prev, ...processed]);
    }
  }, [attachments.length, maxFiles, maxFileSize, acceptedTypes, onError]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processFiles(e.dataTransfer.files);
    }
  }, [processFiles]);

  const handlePaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    // Intercept event ONLY if there are files (like snapshots/pasted files) on the clipboard.
    // Letting text events cascade normally ensures standard string typing works fine.
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      e.preventDefault();
      await processFiles(e.clipboardData.files);
    }
  }, [processFiles]);

  const handleFileChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(e.target.files);
      // Reset input value target key to permit uploading the exact same file twice
      e.target.value = '';
    }
  }, [processFiles]);

  return {
    attachments,
    isDragging,
    addFiles: processFiles,
    removeAttachment,
    clearAttachments,
    dragProps: {
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
    pasteProps: {
      onPaste: handlePaste,
    },
    fileInputProps: {
      onChange: handleFileChange,
      multiple: maxFiles > 1,
      accept: acceptedTypes?.join(','),
    },
  };
}
