export interface FileAttachment {
  id: string;      // Unique identifier for rendering list items and targeting removals
  file: File;      // Original browser File object (for metadata/upload operations)
  name: string;    // Clean filename
  size: number;    // File size in bytes
  type: string;    // Clean MIME type
  dataUrl: string; // The base64 Data URI representing the file
}

export interface UseFileAttachmentOptions {
  maxFileSize?: number;  // in bytes (e.g., 5 * 1024 * 1024 for 5MB)
  maxFiles?: number;     // Maximum allowed concurrent attachments
  acceptedTypes?: string[]; // e.g., ['image/*', 'application/pdf']
  onError?: (error: FileAttachmentError) => void;
}

export interface FileAttachmentError {
  type: 'LIMIT_SIZE' | 'LIMIT_COUNT' | 'UNSUPPORTED_TYPE' | 'READ_ERROR';
  message: string;
  fileName?: string;
}
