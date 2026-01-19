import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export async function connectMongo(): Promise<void> {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => logger.info({ uri: env.mongoUri }, 'Mongo connected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'Mongo connection error'));
  mongoose.connection.on('disconnected', () => logger.warn('Mongo disconnected'));

  await mongoose.connect(env.mongoUri, {
    autoIndex: env.nodeEnv !== 'production',
    serverSelectionTimeoutMS: 10_000,
  });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
