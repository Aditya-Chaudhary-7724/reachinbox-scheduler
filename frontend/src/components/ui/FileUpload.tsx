'use client';

import { useRef, useState, type DragEvent } from 'react';
import { cn } from '@/lib/cn';
import { FileIcon, UploadIcon, XIcon } from '../icons';

export function FileUpload({
  id,
  accept,
  fileName,
  onFile,
  onClear,
  error,
}: {
  id: string;
  accept: string;
  fileName?: string;
  onFile: (file: File) => void;
  onClear: () => void;
  error?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  if (fileName) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
        <FileIcon className="text-brand-600" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
          {fileName}
        </span>
        <button
          type="button"
          onClick={() => {
            if (inputRef.current) inputRef.current.value = '';
            onClear();
          }}
          className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
          aria-label="Remove file"
        >
          <XIcon width={16} height={16} />
        </button>
      </div>
    );
  }

  return (
    <label
      htmlFor={id}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
        dragging
          ? 'border-brand-400 bg-brand-50'
          : error
            ? 'border-red-300 bg-red-50/40'
            : 'border-gray-200 hover:border-brand-300 hover:bg-gray-50',
      )}
    >
      <UploadIcon className="mb-2 text-gray-400" />
      <span className="text-sm text-gray-700">
        <span className="font-medium text-brand-600">Upload a file</span> or drag and drop
      </span>
      <span className="mt-0.5 text-xs text-gray-500">
        CSV or TXT; emails are detected in any column
      </span>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
      />
    </label>
  );
}
