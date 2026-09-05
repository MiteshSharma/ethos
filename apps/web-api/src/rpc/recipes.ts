import { os } from './context';

// Thin RPC shells for the recipes namespace. Every handler is a single service
// call — the six-stage install pipeline lives in `services/recipes.service.ts`.
//
// Auth posture: the namespace is deliberately ABSENT from `SCOPE_MAP`
// (`middleware/dual-auth.ts`), which fails bearer auth closed for every method
// in it — the whole namespace is cookie-only. `install` creates a personality
// and a schedule, and `personalities.create` is already `COOKIE_ONLY` for
// exactly that reason; a bearer key that cannot create a personality directly
// must not create one through a recipe. `list`/`get`/`preflight` could be
// argued read-only, but they exist to feed `install`, and a scope entry for
// them would put the namespace in the map — where a future method silently
// inherits nothing until someone maps it. One posture, no gaps.

export const recipesRouter = {
  list: os.recipes.list.handler(({ context }) => context.recipes.list()),

  get: os.recipes.get.handler(({ input, context }) => context.recipes.get(input.id)),

  preflight: os.recipes.preflight.handler(({ input, context }) =>
    context.recipes.preflight({
      id: input.id,
      ...(input.inputs !== undefined && { inputs: input.inputs }),
      ...(input.personalityIdOverride !== undefined && {
        personalityIdOverride: input.personalityIdOverride,
      }),
      ...(input.installMode !== undefined && { installMode: input.installMode }),
      ...(input.secretBindings !== undefined && { secretBindings: input.secretBindings }),
    }),
  ),

  // Read-only, and it takes a bot TOKEN — which is precisely why it stays in
  // this namespace. `recipes` is absent from `SCOPE_MAP`, so `dualAuth` fails
  // bearer auth closed for every method here; a bearer key minted for an
  // external Mission Control cannot hand us a credential and read a chat list
  // back. Same posture as `install`, which the credential is destined for.
  discoverChats: os.recipes.discoverChats.handler(({ input, context }) =>
    context.recipes.discoverChats({ platform: input.platform, token: input.token }),
  ),

  install: os.recipes.install.handler(({ input, context }) =>
    context.recipes.install({
      id: input.id,
      version: input.version,
      inputs: input.inputs,
      ...(input.personalityIdOverride !== undefined && {
        personalityIdOverride: input.personalityIdOverride,
      }),
      ...(input.installMode !== undefined && { installMode: input.installMode }),
      ...(input.deliverTo !== undefined && { deliverTo: input.deliverTo }),
      ...(input.channelSetup !== undefined && { channelSetup: input.channelSetup }),
      ...(input.secretBindings !== undefined && { secretBindings: input.secretBindings }),
    }),
  ),
};
