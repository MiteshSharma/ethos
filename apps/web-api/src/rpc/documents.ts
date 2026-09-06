import { os } from './context';

// Thin RPC shells for the documents namespace. Bytes are NOT served here —
// download is a streaming HTTP GET and upload a raw HTTP POST, both in
// `routes/documents.ts`.

export const documentsRouter = {
  root: os.documents.root.handler(({ input, context }) => context.documents.root(input)),

  list: os.documents.list.handler(({ input, context }) => context.documents.list(input)),

  delete: os.documents.delete.handler(({ input, context }) => context.documents.delete(input)),

  createFolder: os.documents.createFolder.handler(({ input, context }) =>
    context.documents.createFolder(
      { personalityId: input.personalityId, team: input.team },
      input.root,
      input.path,
    ),
  ),
};
