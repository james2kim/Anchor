import { useRef, useState } from 'react';

interface FileUploadProps {
  onUpload: (file: File) => Promise<void>;
  disabled: boolean;
}

export function FileUpload({ onUpload, disabled }: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      await onUpload(file);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="upload-area">
      <label>Upload Document (PDF, Word, Markdown, Text — up to 100 MB):</label>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx,.doc,.md,.txt"
        disabled={disabled || uploading}
      />
      <button
        className="secondary"
        onClick={handleUpload}
        disabled={disabled || uploading}
      >
        {uploading ? 'Uploading...' : 'Upload'}
      </button>
    </div>
  );
}
