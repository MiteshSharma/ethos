export {
  createOpenClawApiShim,
  extractOpenClawRegister,
  isOpenClawPackageJson,
  OpenClawPluginApiShim,
  type OpenClawCompatCallbacks,
} from './api';

export {
  translateBeforePromptBuildHook,
  translateCorpusSupplement,
  translateMemoryCapability,
  translateMemoryRuntime,
  translatePromptSectionBuilder,
} from './memory-translator';

export {
  translateChannelPlugin,
  unwrapChannelRegistration,
} from './channel-translator';

export type {
  ChannelCapabilities,
  ChannelLifecycleAdapter,
  ChannelMeta,
  ChannelPlugin,
  MemoryPluginCapability,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
  OpenClawHookName,
  OpenClawPackageJsonBlock,
  OpenClawPluginChannelRegistration,
  OpenClawPluginEntry,
  OpenClawPluginManifest,
} from './types';
