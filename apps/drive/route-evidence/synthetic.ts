const folders: Record<string, string> = {
  populated: 'Project records',
  archive: 'Archive notes',
  denied: 'Synthetic title that must not leak'
};

export const synthetic = {
  async authorize(request: Request) {
    return request.headers.get('cookie') === 'route-session=synthetic' ? 'synthetic-reader' : null;
  },
  readAccess: {
    async get(_token: string, id: string) {
      return Object.hasOwn(folders, id) ? { id, name: folders[id], kind: 'folder' as const } : null;
    },
    async list(_token: string, id: string, after: { name: string; id: string } | null) {
      if (id === 'denied') return null;
      const file = { id: 'report', name: 'Quarterly report.pdf', kind: 'file' as const };
      if (id !== 'populated') return { entries: [], nextCursor: null };
      // The source query includes this row: its ID sorts after the empty cursor ID.
      if (after) return after.name === file.name && after.id === '' ? { entries: [file], nextCursor: null } : null;
      return {
        entries: [{ id: 'archive', name: 'Archive notes', kind: 'folder' as const }, file],
        nextCursor: { id: file.id, name: file.name }
      };
    }
  }
};
