import { useQuery } from '@tanstack/react-query';
import { Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DocumentsBrowser } from '../components/documents/DocumentsBrowser';
import { PersonalitySelect } from '../components/personality/PersonalitySelect';
import { useFavouritePersonality } from '../hooks/useFavouritePersonality';
import { resolvePersonalityId } from '../lib/favouritePersonality';
import { rpc } from '../rpc';

// Documents — the operator's view of the files the agent writes.
//
// Ethos usually runs on a headless box under a non-login user. The operator
// has no shell there, so this page is the only way to see, retrieve, or clear
// what the agent produced. It is rooted at the personality's declared
// `fs_reach.workdir`; SOUL.md / config.yaml / mcp.yaml are not on this surface.
//
// The personality selection is OWNED HERE, as component-local `useState`, not
// a shared store — this page threads its own id explicitly into every RPC
// call and into the download URL rather than assuming a global. P2
// (plan/phases/personality-first-ui.md): at `/p/:personalityId/documents` it
// defaults to — and stays in sync with — the route's id rather than the
// independently-remembered favourite; `documents.root`/`documents.list` take
// an optional `personalityId` (omitted = config default), so this is still no
// backend change.

export function Documents() {
  const { personalityId: routePersonalityId } = useParams<{ personalityId?: string }>();
  const [personalityId, setPersonalityId] = useState<string | null>(routePersonalityId ?? null);
  useEffect(() => {
    if (routePersonalityId) setPersonalityId(routePersonalityId);
  }, [routePersonalityId]);
  const { favouriteId, toggleFavourite } = useFavouritePersonality();

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  const personalities = personalitiesQuery.data?.items ?? [];
  const effectiveId = resolvePersonalityId({
    selectedId: personalityId,
    favouriteId,
    defaultId: personalitiesQuery.data?.defaultId ?? null,
    available: personalities.map((p) => p.id),
  });

  return (
    <div className="documents-tab">
      <header className="page-header-row">
        <h1 className="page-h1">Documents</h1>
        <div style={{ flex: 1 }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Personality
        </Typography.Text>
        <PersonalitySelect
          personalities={personalities}
          value={effectiveId}
          onChange={setPersonalityId}
          loading={personalitiesQuery.isLoading}
          favouriteId={favouriteId}
          onToggleFavourite={toggleFavourite}
        />
      </header>

      {personalitiesQuery.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      ) : personalitiesQuery.error ? (
        <Typography.Text type="danger">
          Failed to load personalities: {(personalitiesQuery.error as Error).message}
        </Typography.Text>
      ) : effectiveId ? (
        // Remount on personality change so the browsed path resets to the
        // new root instead of pointing at a subdirectory that may not exist.
        <DocumentsBrowser key={effectiveId} scope={{ personalityId: effectiveId }} />
      ) : (
        <Typography.Text type="secondary">No personalities loaded.</Typography.Text>
      )}
    </div>
  );
}
