import type { IMaterialSlotTreatment } from '../../protocol/schema.js';

export interface IResolvedMaterialSlotTreatment {
  audio: number;
  speed: number;
}

export const CDEFAULT_MATERIAL_SLOT_TREATMENT: IResolvedMaterialSlotTreatment = {
  audio: 0,
  speed: 1,
};

export function resolveMaterialSlotTreatment(
  treatment?: IMaterialSlotTreatment | null,
): IResolvedMaterialSlotTreatment {
  return {
    audio: typeof treatment?.audio === 'number' && Number.isFinite(treatment.audio)
      ? treatment.audio
      : CDEFAULT_MATERIAL_SLOT_TREATMENT.audio,
    speed: typeof treatment?.speed === 'number' && Number.isFinite(treatment.speed) && treatment.speed > 0
      ? treatment.speed
      : CDEFAULT_MATERIAL_SLOT_TREATMENT.speed,
  };
}

export function compactMaterialSlotTreatment(
  treatment: IResolvedMaterialSlotTreatment,
): IMaterialSlotTreatment {
  const compact: IMaterialSlotTreatment = {};
  if (treatment.audio !== CDEFAULT_MATERIAL_SLOT_TREATMENT.audio) {
    compact.audio = treatment.audio;
  }
  if (treatment.speed !== CDEFAULT_MATERIAL_SLOT_TREATMENT.speed) {
    compact.speed = treatment.speed;
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
