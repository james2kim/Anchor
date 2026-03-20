import { useState } from 'react';
import { useDocuments } from '../hooks/useDocuments';
import { ConfirmModal } from './ConfirmModal';

export function DocumentList() {
  const { documents, loading, error, handleDelete } = useDocuments();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  if (loading) {
    return (
      <div className="documents-list">
        <p style={{ textAlign: 'center', color: '#666' }}>Loading documents...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="documents-list">
        <p style={{ textAlign: 'center', color: '#e74c3c' }}>{error}</p>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="documents-list">
        <p style={{ textAlign: 'center', color: '#666' }}>
          No documents uploaded yet. Use the upload area in the Chat tab to add documents.
        </p>
      </div>
    );
  }

  return (
    <div className="documents-list">
      {deleteTarget && (
        <ConfirmModal
          title="Delete Document"
          message={`Are you sure you want to delete "${deleteTarget.name}"? This will also remove all associated chunks and cannot be undone.`}
          onConfirm={() => {
            handleDelete(deleteTarget.id);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {documents.map((doc) => (
        <div key={doc.id} className="document-card">
          <div className="document-card-header">
            <h3>{doc.title || doc.source}</h3>
            <button
              className="document-delete-btn"
              onClick={() => setDeleteTarget({ id: doc.id, name: doc.title || doc.source })}
              title="Delete document"
            >
              Delete
            </button>
          </div>
          <p className="document-summary">
            {doc.summary || 'No summary available'}
          </p>
          <div className="document-meta">
            <span>{doc.source}</span>
            <span>{new Date(doc.created_at).toLocaleDateString()}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
