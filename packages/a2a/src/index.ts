// @ethosagent/a2a — the A2A transport/security module (plan §2).
//
// This main entry carries the HTTP surface (hono): the well-known card router
// factory and the outbound client. It depends on `@ethosagent/types` + `hono` +
// the sibling `./crypto` entry. Importers who need ONLY the pure primitives
// should import `@ethosagent/a2a/crypto` directly so they never pull in hono.
//
// Layer model (ARCHITECTURE §I): this is a `packages/*` module — it MUST NOT
// import from `extensions/*` or `apps/*`. The identity provider is injected.

export {
  A2aAsyncManager,
  type A2aAsyncManagerOptions,
  collectAgentRun,
  type SubmitAsyncArgs,
} from './async';
export {
  type A2aAuditEntry,
  type A2aAuditKind,
  type A2aAuditSink,
  safeAudit,
} from './audit';
export {
  type A2aAuthService,
  type A2aAuthServiceOptions,
  type A2aChallengeStruct,
  type ChallengeRequest,
  type ChallengeResponse,
  type ChallengeResult,
  createA2aAuthRouter,
  createA2aAuthService,
  type RespondResult,
} from './auth';
export {
  A2aClientError,
  type A2aClientErrorCode,
  type FetchAndVerifyCardOptions,
  fetchAndVerifyCard,
} from './client';
export {
  A2A_DELEGATION_CONTEXT,
  type A2aDelegationCredentials,
  A2aDelegationGuard,
  type A2aDelegationGuardOptions,
  type A2aDelegationStruct,
  buildDelegationCredentials,
  type DelegationAdmission,
  signDelegation,
} from './delegation';
export {
  type A2aPreAuthLimiter,
  MemoryA2aLimiter,
  type MemoryA2aLimiterOptions,
  MemoryA2aPreAuthLimiter,
  type MemoryA2aPreAuthLimiterOptions,
  NOOP_PRE_AUTH_LIMITER,
} from './limiter';
export {
  A2aOutboundClient,
  type A2aOutboundClientDeps,
  A2aOutboundError,
  type A2aOutboundErrorCode,
  type A2aOutboundResult,
  type A2aSession,
  type ConnectArgs,
  computeA2aBackoffDelayMs,
  type OutboundDelegation,
  type SendMessageArgs,
} from './outbound';
export {
  type A2aAuthReceipt,
  type SignedA2aAuthReceipt,
  signReceipt,
  verifyReceipt,
} from './receipts';
export {
  A2A_METHOD_MESSAGE_SEND,
  A2A_METHOD_TASKS_SUBSCRIBE,
  A2A_REQUEST_POP_CONTEXT,
  A2A_RPC_AUTH_ERROR_CODES,
  type A2aAsyncSubmitResult,
  type A2aAuthResult,
  type A2aLease,
  type A2aLimiter,
  type A2aMessageSendParams,
  type A2aRequestCredentials,
  type A2aRequestPopStruct,
  type A2aRpcService,
  type A2aRpcServiceOptions,
  type A2aTaskResult,
  type A2aTaskRunner,
  createA2aRpcRouter,
  createA2aRpcService,
  type JsonRpcResponse,
} from './rpc';
export { SQLiteA2aTaskStore } from './sqlite-task-store';
export {
  type A2aAllowlist,
  type A2aAllowlistAdmin,
  type A2aPeerStore,
  type A2aPeerStoreAdmin,
  type AllowlistEntry,
  MemoryNonceStore,
  type MemoryNonceStoreOptions,
  type NonceRecord,
  type NonceStore,
  type PeerEntry,
  type PeerGrant,
  StorageA2aAllowlist,
  StorageA2aPeerStore,
} from './stores';
export {
  type A2aTask,
  type A2aTaskStatus,
  type A2aTaskStore,
  InMemoryA2aTaskStore,
  isTerminalStatus,
  newTaskId,
} from './task-store';
export {
  type A2aTokenClaims,
  type MintedToken,
  type MintTokenParams,
  mintToken,
  type TokenValidation,
  type ValidateTokenOptions,
  validateToken,
} from './tokens';
export {
  type A2aWellKnownRouterOptions,
  createA2aWellKnownRouter,
} from './well-known';
