import { computeCoreCapabilities } from '../services/capabilities';
import { os } from './context';

export const metaRouter = {
  capabilities: os.meta.capabilities.handler(async ({ context }) => {
    const capabilities = await computeCoreCapabilities({
      voice: context.voice,
      config: context.config,
    });
    return { capabilities };
  }),
};
