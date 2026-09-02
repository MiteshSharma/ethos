// Keys — the whole secrets vault, masked, by category
// (plan/phases/keys-secrets-page.md, Phase 3).
//
// This is the only surface that shows EVERYTHING the vault holds. Its backing
// catalog partitions `secrets.list()`: a ref is either claimed by a catalog
// entry or it surfaces under `custom`, so a key dropped in by a plugin, the
// CLI or a hand edit gets a row rather than disappearing.
//
// It is the third read path onto that vault and deliberately does not subsume
// the other two. The Tools rows for Exa, Tavily and Brave are READ-ONLY
// reflections of the named-secrets table on the Security & access pane — the
// service marks them `canSet: false` / `canClear: false` and rejects a write —
// because two panes writing the same three refs is how two panes start
// disagreeing. LLM provider keys are absent for the same reason: they belong
// to Models & providers.
//
// Every row saves on its own (`rpc.keys.set` / `rpc.keys.clear`), never through
// the page Save bar — nothing here is a `~/.ethos/config.yaml` key, so the
// config patch pipeline has nothing to carry. Hence a `SelfSaveMarker` per
// section and no `Form.Item` anywhere in the file.

import { Alert, Typography } from 'antd';
import { Fragment } from 'react';
import { useKeyClear, useKeySet } from '../../../features/settings/api/keys-mutations';
import { useKeysList } from '../../../features/settings/api/keys-queries';
import { rpc } from '../../../rpc';
import { ConnectionRow, SecretField } from '../components/secret-field';
import { SectionHeading } from '../components/section-heading';
import { SelfSaveMarker } from '../components/self-save-marker';
import { keyCategoryPresentation } from '../lib/keys-categories';

type KeyCategoryView = Awaited<ReturnType<typeof rpc.keys.list>>['categories'][number];
type KeyEntryView = KeyCategoryView['entries'][number];

export function KeysPane() {
  const listQuery = useKeysList();
  const setMut = useKeySet();
  const clearMut = useKeyClear();

  const categories = listQuery.data?.categories ?? [];

  if (listQuery.error) {
    return (
      <Alert
        type="error"
        showIcon
        message="Could not read the secrets vault"
        description={(listQuery.error as Error).message}
      />
    );
  }

  return (
    <>
      {categories.map((category) => (
        <Fragment key={category.id}>
          <SectionHeading id={category.id}>
            {keyCategoryPresentation(category.id)?.label ?? category.id}
          </SectionHeading>
          <div style={{ maxWidth: 640, marginBottom: 8 }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
              {keyCategoryPresentation(category.id)?.blurb ?? ''}
            </Typography.Paragraph>
            <SelfSaveMarker />
          </div>
          {category.entries.map((entry) =>
            // A `blob` has no value to type and no probe to run — it is an
            // authorization, so it gets a status line and Disconnect instead
            // of Set / Replace / Test.
            entry.shape === 'blob' ? (
              <ConnectionRow
                key={entry.id}
                entry={entry}
                clearing={clearMut.isPending}
                onClear={() => clearMut.mutate({ id: entry.id })}
              />
            ) : (
              <SecretField
                key={entry.id}
                entry={entry}
                saving={setMut.isPending}
                clearing={clearMut.isPending}
                onSave={(values) => setMut.mutate({ id: entry.id, values })}
                onClear={() => clearMut.mutate({ id: entry.id })}
                {...(entry.probe ? { onTest: () => testEntry(entry) } : {})}
              />
            ),
          )}
        </Fragment>
      ))}
      {!listQuery.isLoading && categories.length === 0 ? (
        <Typography.Text type="secondary">The secrets vault is empty.</Typography.Text>
      ) : null}
    </>
  );
}

/**
 * The one live probe that exists (plan, "Live-probe scope"): the reflected
 * exa/tavily/brave rows, tested through the service that owns them. `probe`
 * IS the provider — a closed union in the catalog — and the named secret's
 * own name is the last segment of the ref it reflects
 * (`providers/<provider>/<name>`).
 */
async function testEntry(entry: KeyEntryView): Promise<{ ok: boolean; error?: string }> {
  const provider = entry.probe;
  const segments = entry.fields[0]?.ref.split('/') ?? [];
  const secretName = segments[2];
  if (!provider || !secretName) return { ok: false, error: 'No key stored to test.' };
  return rpc.namedSecrets.testKey({ provider, name: secretName });
}
