import { os } from './context';

// Thin RPC shells for the documents namespace. Bytes are NOT served here —
// download is a streaming HTTP GET (`routes/documents.ts`).

export const documentsRouter = {
  root: os.documents.root.handler(({ input, context }) =>
    context.documents.root(input.personalityId),
  ),

  list: os.documents.list.handler(({ input, context }) => context.documents.list(input)),

  delete: os.documents.delete.handler(({ input, context }) => context.documents.delete(input)),
};
