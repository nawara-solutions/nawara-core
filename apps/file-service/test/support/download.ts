/** A test service policy covering the Stage 17.6 cases. */
export const DOWNLOAD_POLICY = {
  callers: {
    'core-drive': { operations: ['upload', 'read', 'attach', 'issue_ticket'], organizations: 'request', mediaTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'], maxBytes: 25 * 1024 * 1024 },
    'core-billing': { operations: ['upload', 'read', 'issue_ticket'], organizations: 'none', mediaTypes: ['application/pdf'], maxBytes: 1024 * 1024 },
    'core-uploader': { operations: ['upload'], organizations: 'request', mediaTypes: ['application/pdf'], maxBytes: 1024 * 1024 },
  },
};
