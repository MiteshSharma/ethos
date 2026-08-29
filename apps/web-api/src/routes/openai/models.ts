import { Hono } from 'hono';
import { openAiErrorBody } from '../../middleware/bearer-auth';
import type { PersonalitiesService } from '../../services/personalities.service';

// `GET /v1/models` + `GET /v1/models/{id}` — OpenAI-shape catalog of agents the
// client can target: every personality plus the `ethos-default` alias. Bearer
// auth is applied at the parent mount.
//
// Everything listed here must be accepted by `POST /v1/chat/completions`, so a
// model picker never offers a selection that is guaranteed to fail. That is why
// `team:` ids are not advertised: chat rejects them with 400
// `team_routing_not_implemented` until team routing lands.

export interface OpenAiModelsRouteOptions {
  personalities: PersonalitiesService;
  /**
   * Returns currently registered team names (no prefix). Accepted but not yet
   * advertised — see the module comment. Kept so callers can keep wiring it.
   */
  listTeams?: () => Promise<string[]>;
}

export interface OpenAiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface OpenAiModelList {
  object: 'list';
  data: OpenAiModel[];
}

export function openAiModelsRoutes(opts: OpenAiModelsRouteOptions): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const body: OpenAiModelList = { object: 'list', data: await listModels(opts) };
    return c.json(body);
  });

  // `GET /v1/models/{id}` — clients probe a specific id before using it. An id
  // that is not in the list 404s, matching what chat would do with it.
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const found = (await listModels(opts)).find((m) => m.id === id);
    if (!found) {
      return c.json(
        openAiErrorBody({
          message: `Model "${id}" not found. Use \`GET /v1/models\` to list available ids.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
          param: 'model',
        }),
        404,
      );
    }
    return c.json(found);
  });

  return app;
}

async function listModels(opts: OpenAiModelsRouteOptions): Promise<OpenAiModel[]> {
  const personalities = (await opts.personalities.list()).items;
  return [...personalities.map((p) => modelEntry(p.id)), modelEntry('ethos-default')];
}

function modelEntry(id: string): OpenAiModel {
  return { id, object: 'model', created: 0, owned_by: 'ethos' };
}
