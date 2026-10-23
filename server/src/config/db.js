import mongoose from 'mongoose';
import { env } from './env.js';
import { ProductionRecord } from '../models/ProductionRecord.js';

export async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri);
  console.log('[db] connected to MongoDB');

  // ProductionRecord's unique key gained businessUnit when Bhilai's progress tabs were added.
  // Mongoose creates missing indexes on its own but never drops superseded ones, so without
  // this the old { date, client, processStage } index would stay — and keep rejecting a Bhilai
  // row whose client name happens to match an HSD one. Only this model is synced: it is the
  // only key that has changed, and syncIndexes drops anything not in the schema.
  try {
    await ProductionRecord.syncIndexes();
  } catch (err) {
    console.error('[db] could not sync ProductionRecord indexes:', err.message);
  }

  mongoose.connection.on('error', (err) => {
    console.error('[db] connection error:', err.message);
  });
}
