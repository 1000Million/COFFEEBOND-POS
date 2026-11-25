const UOM_ALIASES = {
  G: 'G',
  GRAM: 'G',
  GRAMS: 'G',
  KG: 'KG',
  KGS: 'KG',
  KILOGRAM: 'KG',
  KILOGRAMS: 'KG',
  ML: 'ML',
  MILLILITRE: 'ML',
  MILLILITER: 'ML',
  MILLILITRES: 'ML',
  MILLILITERS: 'ML',
  L: 'L',
  LTR: 'L',
  LTRS: 'L',
  LITRE: 'L',
  LITER: 'L',
  LITRES: 'L',
  LITERS: 'L',
  PCS: 'PCS',
  PC: 'PCS',
  PIECE: 'PCS',
  PIECES: 'PCS',
};

const UOM_SCALE = {
  G: { family: 'WEIGHT', baseFactor: 1 },
  KG: { family: 'WEIGHT', baseFactor: 1000 },
  ML: { family: 'VOLUME', baseFactor: 1 },
  L: { family: 'VOLUME', baseFactor: 1000 },
  PCS: { family: 'COUNT', baseFactor: 1 },
};

export const TARGET_LIQUID_PREP_CODES = [
  'PROTEIN_POWER_BASE',
  'BERRY_ME_BASE',
  'COLLAGEN_SMOOTHIE_BASE',
  'CHOCOLATE_BASE',
  'MOCHA_BASE',
  'TIRAMISU_BASE',
  'VITA_C_BLISS_BASE',
];

export const CONFIRMED_UNIT_LABEL_REPAIR_CODES = [
  'PROTEIN_POWER_BASE',
  'COLLAGEN_SMOOTHIE_BASE',
  'CHOCOLATE_BASE',
  'MOCHA_BASE',
  'TIRAMISU_BASE',
  'VITA_C_BLISS_BASE',
];

export function normalizeUom(value) {
  const raw = String(value || '').trim().toUpperCase();
  return UOM_ALIASES[raw] || raw;
}

export function unitFamily(value) {
  return UOM_SCALE[normalizeUom(value)]?.family || 'UNKNOWN';
}

export function canConvertUom(fromUom, toUom) {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!from || !to) return false;
  if (from === to) return true;
  const fromMeta = UOM_SCALE[from];
  const toMeta = UOM_SCALE[to];
  return Boolean(fromMeta && toMeta && fromMeta.family === toMeta.family);
}

export function convertQuantity(quantity, fromUom, toUom) {
  const amount = Number(quantity);
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!Number.isFinite(amount) || amount <= 0 || !from || !to) return null;
  if (from === to) return { quantity: Math.round(amount * 10000) / 10000, normalized: false };
  const fromMeta = UOM_SCALE[from];
  const toMeta = UOM_SCALE[to];
  if (!fromMeta || !toMeta || fromMeta.family !== toMeta.family) return null;
  const baseQuantity = amount * fromMeta.baseFactor;
  return {
    quantity: Math.round((baseQuantity / toMeta.baseFactor) * 10000) / 10000,
    normalized: true,
  };
}

export function deriveLiquidPrepUnitDecision({ prepCode, currentUnit, consumptionUnits }) {
  const normalizedUnits = Array.from(new Set(consumptionUnits.map(normalizeUom).filter(Boolean)));
  const current = normalizeUom(currentUnit);
  const allVolume = normalizedUnits.length > 0 && normalizedUnits.every((unit) => unitFamily(unit) === 'VOLUME');
  const allWeight = normalizedUnits.length > 0 && normalizedUnits.every((unit) => unitFamily(unit) === 'WEIGHT');

  if (!TARGET_LIQUID_PREP_CODES.includes(prepCode)) {
    return {
      proposedUnit: current || '',
      status: 'NOT_TARGETED',
      reason: 'Prep item is not in the approved seven-item liquid base repair list.',
    };
  }

  if (allVolume) {
    return {
      proposedUnit: 'ML',
      status: current === 'ML' ? 'ALREADY_CORRECT' : 'PROPOSE_ML',
      reason: 'All finished-good BOM consumption lines use a volume unit. No density conversion is required for ML stock.',
    };
  }

  if (allWeight) {
    return {
      proposedUnit: current || 'G',
      status: 'OWNER_DENSITY_REQUIRED',
      reason: 'Finished goods consume this prep item by weight. Keep G/KG unless an approved density conversion exists.',
    };
  }

  return {
    proposedUnit: '',
    status: 'AMBIGUOUS_UNITS',
    reason: `Mixed or missing consumption units: ${normalizedUnits.join(', ') || 'none'}. Owner approval required.`,
  };
}
