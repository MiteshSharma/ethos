// Generic plugin registry — adapted from praxis PluginRegistry pattern.
// Each subsystem (tools, channels, memory backends) gets its own instance.

export type PluginFactory<T, C = unknown> = (config: C) => T | null;

export class PluginRegistry<T, C = unknown> {
  private readonly factories = new Map<string, PluginFactory<T, C>>();

  register(type: string, factory: PluginFactory<T, C>): void {
    this.factories.set(type, factory);
  }

  create(type: string, config: C): T {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(
        `Unknown plugin type: "${type}". Registered: ${[...this.factories.keys()].join(', ')}`,
      );
    }
    const instance = factory(config);
    if (!instance) {
      throw new Error(`Plugin factory for "${type}" returned null`);
    }
    return instance;
  }

  has(type: string): boolean {
    return this.factories.has(type);
  }

  types(): string[] {
    return [...this.factories.keys()];
  }
}
