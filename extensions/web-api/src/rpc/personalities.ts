import { os } from './context';

// Personalities namespace — list/get/create/update/delete/duplicate
// plus per-personality skills CRUD + import-from-global. Handlers stay
// thin; mutations route through PersonalitiesService.

export const personalitiesRouter = {
  list: os.personalities.list.handler(({ context }) => context.personalities.list()),

  get: os.personalities.get.handler(({ input, context }) => context.personalities.get(input.id)),

  create: os.personalities.create.handler(({ input, context }) =>
    context.personalities.create({
      id: input.id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      toolset: input.toolset,
      ethosMd: input.ethosMd,
      ...(input.memoryScope !== undefined ? { memoryScope: input.memoryScope } : {}),
    }),
  ),

  update: os.personalities.update.handler(({ input, context }) => {
    const { id, mcp_servers, plugins, ...rest } = input;
    return context.personalities.update(id, {
      ...rest,
      ...(mcp_servers !== undefined ? { mcp_servers } : {}),
      ...(plugins !== undefined ? { plugins } : {}),
    });
  }),

  delete: os.personalities.delete.handler(async ({ input, context }) => {
    await context.personalities.delete(input.id);
    return { ok: true as const };
  }),

  duplicate: os.personalities.duplicate.handler(({ input, context }) =>
    context.personalities.duplicate(input.id, input.newId),
  ),

  skillsList: os.personalities.skillsList.handler(({ input, context }) =>
    context.personalities.skillsList(input.personalityId),
  ),

  skillsGet: os.personalities.skillsGet.handler(({ input, context }) =>
    context.personalities.skillsGet(input.personalityId, input.skillId),
  ),

  skillsCreate: os.personalities.skillsCreate.handler(({ input, context }) =>
    context.personalities.skillsCreate(input.personalityId, input.skillId, input.body),
  ),

  skillsUpdate: os.personalities.skillsUpdate.handler(({ input, context }) =>
    context.personalities.skillsUpdate(input.personalityId, input.skillId, input.body),
  ),

  skillsDelete: os.personalities.skillsDelete.handler(async ({ input, context }) => {
    await context.personalities.skillsDelete(input.personalityId, input.skillId);
    return { ok: true as const };
  }),

  skillsImportGlobal: os.personalities.skillsImportGlobal.handler(({ input, context }) =>
    context.personalities.skillsImportGlobal(input.personalityId, input.skillIds),
  ),
};
