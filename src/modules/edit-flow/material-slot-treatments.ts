import type { IMaterialSlotTreatment } from '../../protocol/schema.js';

export interface IResolvedMaterialSlotTreatment {
  audio: number;
  speed: number;
}

export const CDEFAULT_MATERIAL_SLOT_TREATMENT: IResolvedMaterialSlotTreatment = {
  audio: 0,
  speed: 1,
};

export const CMATERIAL_SLOT_SPEED_MIN = 1;
export const CMATERIAL_SLOT_SPEED_MAX = 5;

export function isValidMaterialSlotSpeedMultiplier(speed: unknown): speed is number {
  return typeof speed === 'number'
    && Number.isFinite(speed)
    && Number.isInteger(speed)
    && speed >= CMATERIAL_SLOT_SPEED_MIN
    && speed <= CMATERIAL_SLOT_SPEED_MAX;
}

export function normalizeMaterialSlotSpeedMultiplier(speed: unknown): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) {
    return CDEFAULT_MATERIAL_SLOT_TREATMENT.speed;
  }
  return Math.min(
    CMATERIAL_SLOT_SPEED_MAX,
    Math.max(CMATERIAL_SLOT_SPEED_MIN, Math.ceil(speed)),
  );
}

export function resolveMaterialSlotTreatment(
  treatment?: IMaterialSlotTreatment | null,
): IResolvedMaterialSlotTreatment {
  return {
    audio: typeof treatment?.audio === 'number' && Number.isFinite(treatment.audio)
      ? treatment.audio
      : CDEFAULT_MATERIAL_SLOT_TREATMENT.audio,
    speed: normalizeMaterialSlotSpeedMultiplier(treatment?.speed),
  };
}

export function compactMaterialSlotTreatment(
  treatment: IResolvedMaterialSlotTreatment,
): IMaterialSlotTreatment {
  const compact: IMaterialSlotTreatment = {};
  if (treatment.audio !== CDEFAULT_MATERIAL_SLOT_TREATMENT.audio) {
    compact.audio = treatment.audio;
  }
  const speed = normalizeMaterialSlotSpeedMultiplier(treatment.speed);
  if (speed !== CDEFAULT_MATERIAL_SLOT_TREATMENT.speed) {
    compact.speed = speed;
  }
  return compact;
}

export function compactMaterialSlotTreatments(
  treatments: Record<string, IResolvedMaterialSlotTreatment>,
): Record<string, IMaterialSlotTreatment> {
  const compact: Record<string, IMaterialSlotTreatment> = {};
  for (const [spanId, treatment] of Object.entries(treatments)) {
    const next = compactMaterialSlotTreatment(treatment);
    if (Object.keys(next).length > 0) {
      compact[spanId] = next;
    }
  }
  return compact;
}
