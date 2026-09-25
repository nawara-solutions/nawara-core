/** A test service policy covering the Stage 17.7 cases (core-drive may delete; core-reader may not). */
export const DELETE_POLICY = {
  callers: {
    'core-drive': { operations: ['upload', 'read', 'attach', 'delete', 'issue_ticket'], organizations: 'request', mediaTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'], maxBytes: 25 * 1024 * 1024 },
    'core-billing': { operations: ['upload', 'read', 'delete'], organizations: 'none', mediaTypes: ['application/pdf'], maxBytes: 1024 * 1024 },
    'core-reader': { operations: ['read'], organizations: 'none' },
  },
};
