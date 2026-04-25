import pino from 'pino';

// Logs go to stderr so they never collide with ACP JSON-RPC on stdout.
// Default level is 'warn' — silent in normal CLI use; override with LOG_LEVEL=debug.
export const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' }, process.stderr);
