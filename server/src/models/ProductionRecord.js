import mongoose from 'mongoose';

const productionRecordSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    // Which plant produced it. Bhilai has its own progress tabs ("AMNS - Bhilai", "Utility
    // Bridge - Bhilai", "Bhilai MHI Duct Progress"), and every one of them carries blocks headed
    // with an HSD client's name — leftovers from whoever copied the sheet. Without this field a
    // Bhilai block headed "RIL" would land on the same key as HSD's RIL and overwrite it, which
    // is the same double-count the client-from-the-block rule exists to prevent (§7.3).
    // Rows written before Bhilai production existed carry no value and are HSD, so HSD queries
    // ask for { $ne: 'BU' } rather than { businessUnit: 'HSD' }.
    businessUnit: { type: String, enum: ['HSD', 'BU'], default: 'HSD' },
    client: { type: String, required: true },
    processStage: {
      type: String,
      enum: ['cutting', 'fitUp', 'welding', 'visual', 'blasting', 'finalCoat'],
      required: true,
    },
    cumulativeQty: { type: Number, required: true, min: 0 },
    // No lower bound: the sheet records corrections as negative increments (RIL, June 2025:
    // welding −87 and blasting −95, matching the running total falling by the same amounts).
    // They are real, and totals built from increments are only right if they are counted.
    // This constraint went unnoticed while bulkWrite skipped validation; enforcing it would have
    // thrown those corrections away.
    dailyIncrementQty: { type: Number, required: true },
    targetQty: { type: Number, default: null },
    unit: { type: String, default: null },
    sourceTab: { type: String, required: true },
    // The cumulative cell this record was read from, so any figure traces back to the sheet.
    sourceRowIndex: { type: Number, default: null },
    sourceCol: { type: Number, default: null },
    syncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// businessUnit joins the key for the reason above. config/db.js re-syncs this index at boot so
// a deploy replaces the old three-field one rather than leaving both in place.
productionRecordSchema.index(
  { date: 1, businessUnit: 1, client: 1, processStage: 1 },
  { unique: true },
);

export const ProductionRecord = mongoose.model('ProductionRecord', productionRecordSchema);
