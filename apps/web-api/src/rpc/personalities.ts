import { os } from './context';
import { personalitiesLearningRouter } from './personalities-learning';
import { personalitiesSkillCandidatesRouter } from './personalities-skill-candidates';

// Personalities namespace — CRUD, per-personality skills CRUD + import, and
// the read-only derivations (character sheet, renderers). Handlers stay thin;
// all logic routes through PersonalitiesService. Governed-learning and
// skill-candidate procedures live in the sibling modules imported above.

export const personalitiesRouter = {
  list: os.personalities.list.handler(({ context }) => context.personalities.list()),

  get: os.personalities.get.handler(({ input, context }) => context.personalities.get(input.id)),

  characterSheet: os.personalities.characterSheet.handler(({ input, context }) =>
    context.personalities.characterSheet(input.id),
  ),

  create: os.personalities.create.handler(({ input, context }) =>
    context.personalities.create({
      id: input.id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      toolset: input.toolset,
      soulMd: input.soulMd,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
      ...(input.mcp_servers !== undefined ? { mcp_servers: input.mcp_servers } : {}),
      ...(input.plugins !== undefined ? { plugins: input.plugins } : {}),
      ...(input.fs_reach !== undefined ? { fs_reach: input.fs_reach } : {}),
      ...(input.skill_evolution !== undefined ? { skill_evolution: input.skill_evolution } : {}),
      ...(input.evolution_approval_mode !== undefined
        ? { evolution_approval_mode: input.evolution_approval_mode }
        : {}),
      ...(input.nightly !== undefined ? { nightly: input.nightly } : {}),
    }),
  ),

  update: os.personalities.update.handler(async ({ input, context }) => {
    // Exclude `mcp_tools` (an off-schema mcp.yaml sibling) and `memory` (wire
    // `provider` is optional, the patch requires it) from the patch; everything
    // else maps 1:1. `dreaming` carries enable + optional cadence and is
    // shallow-merged by the registry onto the existing block.
    const { id, mcp_tools, memory, ...rest } = input;
    const result = await context.personalities.update(id, {
      ...rest,
      ...(memory?.provider !== undefined ? { memory: { provider: memory.provider } } : {}),
    });
    // Per-server MCP tool subsets are written after the config update. Ignored
    // unless `mcp_servers` was also supplied — `mcp_tools` alone has no servers.
    if (rest.mcp_servers !== undefined && mcp_tools !== undefined) {
      await context.personalities.writeMcpToolSubsetsFor(id, rest.mcp_servers, mcp_tools);
    }
    return result;
  }),

  delete: os.personalities.delete.handler(async ({ input, context }) => {
    // Risk #3: warn server-side if cron jobs still reference this personality.
    // They will fail gracefully at trigger time with CRON_PERSONALITY_MISSING.
    const { jobs } = await context.cron.list();
    const dependent = (jobs as Array<{ personalityId: string; name: string }>).filter(
      (j) => j.personalityId === input.id,
    );
    if (dependent.length > 0) {
      const names = dependent.map((j) => j.name).join(', ');
      console.warn(
        `[personalities] Deleting "${input.id}" but ${dependent.length} cron job(s) still reference it: ${names}`,
      );
    }
    await context.personalities.delete(input.id);
    return { ok: true as const };
  }),

  duplicate: os.personalities.duplicate.handler(({ input, context }) =>
    context.personalities.duplicate(input.id, input.newId),
  ),

  renderers: os.personalities.renderers.handler(({ input, context }) =>
    context.personalities.renderers(input.id),
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

  mcpSetToken: os.personalities.mcpSetToken.handler(async ({ input, context }) => {
    await context.personalities.mcpSetToken(input.personalityId, input.server, input.token);
    return { ok: true as const };
  }),

  mcpDeleteToken: os.personalities.mcpDeleteToken.handler(async ({ input, context }) => {
    await context.personalities.mcpDeleteToken(input.personalityId, input.server);
    return { ok: true as const };
  }),
  ...personalitiesLearningRouter,
  ...personalitiesSkillCandidatesRouter,
};
