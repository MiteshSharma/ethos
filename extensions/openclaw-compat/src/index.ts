export {
  createOpenClawApiShim,
  extractOpenClawRegister,
  isOpenClawPackageJson,
  type OpenClawCompatCallbacks,
  OpenClawPluginApiShim,
} from './api';
export {
  translateChannelPlugin,
  unwrapChannelRegistration,
} from './channel-translator';
export {
  translateBeforePromptBuildHook,
  translateCorpusSupplement,
  translateMemoryCapability,
  translateMemoryRuntime,
  translatePromptSectionBuilder,
} from './memory-translator';

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
