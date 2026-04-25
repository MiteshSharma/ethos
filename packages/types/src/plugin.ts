export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  extensions: string[];
  compat?: {
    pluginApi: string;
  };
}
