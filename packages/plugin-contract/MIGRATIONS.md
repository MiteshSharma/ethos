# Plugin Contract Migrations

## Deprecation policy

**No overlap window.** When `PLUGIN_CONTRACT_MAJOR` is bumped, support for the
prior major is dropped in the same release. Rationale: the install base is small
enough that an overlap window adds complexity without protecting users. If scale
later demands a grace period, revisit and document that change here.

The rule for plugin authors is simple: when a new major is published, update
your `package.json` → `ethos.pluginContractMajor` and apply the patch described
in the relevant section below. If your plugin has no `pluginContractMajor`
field, the loader allows it (backward compat for older plugins); add the field
before publishing to ClawHub.

---

## Entry template

When the next major bump happens, copy this block, fill in the blanks, and
delete the placeholder text.

```markdown
## Major N → N+1 (YYYY-MM-DD)

### What changed

One paragraph: which field was renamed / removed / required.

### Why

One paragraph: the architectural reason. Future-you reading a bug report will
thank past-you for this.

### Migration

Step-by-step patch for plugin authors:

1. Update `package.json` → `ethos.pluginContractMajor` from `N` to `N+1`.
2. [Rename / remove / add] `<field>` in `activate(api)` / plugin manifest.
3. Run `pnpm test` against the updated contract to confirm compatibility.

### Affected symbol(s)

- `EthosPluginApi.<method>` — describe the change
- `@ethosagent/plugin-sdk:<export>` — describe the change
```

---

## Major 1 (current)

Initial contract. No migration required — major 1 is the baseline.

Fields in scope:

- `package.json.ethos.type` — must be `"plugin"`
- `package.json.ethos.pluginContractMajor` — optional integer; omit for pre-1.0
  plugins; set to `1` for all new plugins
- `package.json.ethos.id` — optional stable plugin identifier
- `activate(api: EthosPluginApi): void | Promise<void>` — entry point
- `deactivate?(): void | Promise<void>` — optional teardown
- `EthosPluginApi.registerTool(tool)`
- `EthosPluginApi.registerVoidHook(name, handler)`
- `EthosPluginApi.registerModifyingHook(name, handler)`
- `EthosPluginApi.registerInjector(injector)`
- `EthosPluginApi.registerPersonality(config)`
