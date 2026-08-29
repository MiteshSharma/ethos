import { CARD_SPEC_VERSION, type CardEnvelope } from '@ethosagent/web-contracts';
import { type ComponentType, lazy } from 'react';
import { AlertCardBlock } from './blocks/AlertCardBlock';
import { CodeCardBlock } from './blocks/CodeCardBlock';
import { DataTableCardBlock } from './blocks/DataTableCardBlock';
import { DetailCardBlock } from './blocks/DetailCardBlock';
import { ItemListCardBlock } from './blocks/ItemListCardBlock';
import { MetricChartBlock } from './blocks/MetricChartBlock';
import { RecommendActionsBlock } from './blocks/RecommendActionsBlock';
import { TextCardBlock } from './blocks/TextCardBlock';
import { UnknownCardBlock } from './blocks/UnknownCardBlock';

// `kind@specVersion` → component, the card-side twin of
// `features/renderers/registry.ts`. Two deliberate asymmetries with that file:
//
//   • NOT personality-gated. A fence renderer runs skill-authored content, so
//     the personality has to declare it. Cards are framework-owned components
//     fed payloads that passed the web-contracts schema at the tool, at the
//     broadcast gate and again in the reducer — there is nothing for a
//     personality to opt into.
//   • NOT iframed, for the same reason: the payload is data, never markup or
//     script. `canvas` is the one exception and it keeps its iframe (see
//     CanvasBlock).
//
// Everything is a static import except `canvas`, which may pull a library
// bundle behind it. `metric_chart` is static here and suspends internally on
// the echarts chunk the fence renderers already own.
//
// `lazy()` is called once, at module scope. Inside a component it would mint a
// fresh element type per render and remount the iframe on every keystroke.

export interface CardBlockProps {
  card: CardEnvelope;
  /** Puts text in the composer. Only `recommend_actions` uses it. */
  onSuggestPrompt?: (prompt: string) => void;
}

export type CardComponent = ComponentType<CardBlockProps>;

const LazyCanvasBlock = lazy(() => import('./blocks/CanvasBlock'));

export const CARD_RENDERERS: ReadonlyMap<string, CardComponent> = new Map<string, CardComponent>([
  [`text@${CARD_SPEC_VERSION}`, TextCardBlock],
  [`code@${CARD_SPEC_VERSION}`, CodeCardBlock],
  [`alert@${CARD_SPEC_VERSION}`, AlertCardBlock],
  [`detail@${CARD_SPEC_VERSION}`, DetailCardBlock],
  [`item_list@${CARD_SPEC_VERSION}`, ItemListCardBlock],
  [`data_table@${CARD_SPEC_VERSION}`, DataTableCardBlock],
  [`metric_chart@${CARD_SPEC_VERSION}`, MetricChartBlock],
  [`recommend_actions@${CARD_SPEC_VERSION}`, RecommendActionsBlock],
  [`canvas@${CARD_SPEC_VERSION}`, LazyCanvasBlock],
]);

/**
 * The component for this kind at this spec version. An unknown kind and a
 * known kind at a version this build does not implement get the same answer:
 * the labelled fallback. Never null, so a card is never a blank gap and never
 * a thrown render.
 */
export function resolveCardRenderer(kind: string, specVersion: number): CardComponent {
  return CARD_RENDERERS.get(`${kind}@${specVersion}`) ?? UnknownCardBlock;
}
