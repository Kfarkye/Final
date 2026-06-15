import React from 'react';

export const getFileIcon = (mimeType: string, filename: string): React.ReactNode => {
  const extension = filename.split('.').pop()?.toLowerCase();

  // Images
  if (mimeType.startsWith('image/')) {
    return (
      <svg className="w-4 h-4 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    );
  }

  // Documents/PDFs
  if (mimeType === 'application/pdf' || extension === 'pdf') {
    return (
      <svg className="w-4 h-4 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
    );
  }

  // Spreadsheets
  if (
    mimeType === 'text/csv' ||
    mimeType.includes('spreadsheetml') ||
    mimeType.includes('excel') ||
    ['csv', 'xls', 'xlsx'].includes(extension || '')
  ) {
    return (
      <svg className="w-4 h-4 text-teal-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    );
  }

  // Code formats
  if (
    mimeType.startsWith('text/') ||
    mimeType.includes('javascript') ||
    mimeType.includes('json') ||
    ['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json', 'py', 'sh', 'rs'].includes(extension || '')
  ) {
    return (
      <svg className="w-4 h-4 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    );
  }

  // Fallback (Generic file)
  return (
    <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
};
