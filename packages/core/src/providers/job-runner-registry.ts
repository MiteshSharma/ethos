import type {
  JobRunner,
  JobRunnerFactory,
  JobRunnerFactoryContext,
  JobRunnerRegistry,
} from '@ethosagent/types';

/**
 * Default job-runner registry.
 *
 * Same lifecycle as `DefaultExecutionBackendRegistry`: register a factory →
 * resolve() it into a concrete instance → get() the cached instance. Two maps
 * because get() must return an INSTANCE (not a factory) and factories may be
 * async, so resolution is a distinct step from registration.
 *
 * The executor and the delegation tool both read through `get()`, so a runner
 * that is registered but never resolved is deliberately invisible to them —
 * "registered" is a promise, "resolved" is a runner.
 */
export class DefaultJobRunnerRegistry implements JobRunnerRegistry {
  private readonly factories = new Map<string, JobRunnerFactory>();
  private readonly instances = new Map<string, JobRunner>();

  register(name: string, factory: JobRunnerFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`Job runner "${name}" is already registered`);
    }
    this.factories.set(name, factory);
  }

  async resolve(name: string, ctx: JobRunnerFactoryContext): Promise<JobRunner> {
    const cached = this.instances.get(name);
    if (cached) return cached;
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Job runner "${name}" is not registered`);
    }
    const instance = await factory(ctx);
    this.instances.set(name, instance);
    return instance;
  }

  get(name: string): JobRunner | undefined {
    return this.instances.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
