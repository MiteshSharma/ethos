import { EthosClient, HttpDispatcher } from '@ethosagent/sdk';

const apiBase =
  import.meta.env.VITE_API_URL ?? (typeof window !== 'undefined' ? window.location.origin : '');

export const client = new EthosClient(new HttpDispatcher({ baseUrl: apiBase }));
export const rpc = client.rpc;
