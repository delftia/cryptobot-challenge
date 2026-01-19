import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.logLevel,
  base: undefined,
  redact: {
    paths: ['req.headers.authorization'],
    remove: true,
  },
});
