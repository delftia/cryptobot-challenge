import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['req.headers.authorization'],
    remove: true,
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
});
