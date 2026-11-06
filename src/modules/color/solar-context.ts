import type { IColorInput } from '../../store/color-inputs.js';

const rad = Math.PI / 180;
const dayMs = 86_400_000;
export type SolarPhase = 'day' | 'low-sun' | 'civil-twilight' | 'night';
export interface SolarContext {
  version: 'noaa-approx-v1';
  status: 'available' | 'unknown';
  reason?: string;
  gps?: { lat: number; lng: number; source: string; confidence: number };
  samples: { sourceMs: number; at: string; elevationDegrees: number; phase: SolarPhase }[];
  days: { solarDate: string; sunriseAt: string | null; sunsetAt: string | null; polar: 'day' | 'night' | null }[];
}

// NOAA's approximate equations. All arithmetic is UTC; host timezone is irrelevant.
function terms(time: number) {
  const d = new Date(time), year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const days = (Date.UTC(year + 1, 0, 1) - yearStart) / dayMs;
  const gamma = 2 * Math.PI / days * ((time - yearStart) / dayMs - 0.5);
  const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  return { equation, declination };
}

export function solarElevation(time: number, lat: number, lng: number): number {
  const { equation, declination } = terms(time);
  const minutes = ((time % dayMs) + dayMs) % dayMs / 60000;
  const solarMinutes = ((minutes + equation + 4 * lng) % 1440 + 1440) % 1440;
  const hourAngle = (solarMinutes / 4 - 180) * rad;
  const cosZenith = Math.sin(lat * rad) * Math.sin(declination)
    + Math.cos(lat * rad) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, cosZenith))) / rad;
}

export function solarDay(time: number, lat: number, lng: number): SolarContext['days'][number] {
  const solarDate = new Date(time + lng * 4 * 60000).toISOString().slice(0, 10);
  const midnight = Date.parse(`${solarDate}T00:00:00Z`);
  let noon = midnight + (720 - 4 * lng) * 60000;
  for (let i = 0; i < 3; i++) noon = midnight + (720 - 4 * lng - terms(noon).equation) * 60000;
  const angleAt = (t: number) => {
    const { declination } = terms(t);
    return (Math.cos(90.833 * rad) - Math.sin(lat * rad) * Math.sin(declination))
      / (Math.cos(lat * rad) * Math.cos(declination));
  };
  const cosH = angleAt(noon);
  if (cosH < -1 || cosH > 1) return { solarDate, sunriseAt: null, sunsetAt: null, polar: cosH < -1 ? 'day' : 'night' };
  const event = (sign: number) => {
    let t = noon;
    for (let i = 0; i < 3; i++) {
      const c = angleAt(t);
      if (Math.abs(c) > 1) return null;
      t = midnight + (720 - 4 * lng - terms(t).equation + sign * 4 * Math.acos(c) / rad) * 60000;
    }
    return new Date(t).toISOString();
  };
  return { solarDate, sunriseAt: event(-1), sunsetAt: event(1), polar: null };
}

export function buildSolarContext(input: IColorInput): SolarContext {
  const base = { version: 'noaa-approx-v1' as const, samples: [], days: [] };
  const embedded = input.media.embeddedGps;
  const gps = embedded ? { lat: embedded.representativeLat, lng: embedded.representativeLng,
    source: 'embedded', confidence: embedded.confidence } : input.facts?.gps;
  // Reject timezone-less strings rather than interpreting them in the process timezone.
  const capture = input.media.capturedAt;
  const start = capture && /(?:Z|[+-]\d\d:\d\d)$/i.test(capture) ? Date.parse(capture) : NaN;
  if (!gps || !Number.isFinite(start) || gps.confidence < 0.5) return { ...base, status: 'unknown', reason: '缺少可靠 GPS 或带时区的校正拍摄时间' };
  const duration = Math.max(0, input.media.durationMs ?? 0);
  const times = [...new Set([0, duration / 2, duration])];
  const samples = times.map(sourceMs => {
    const elevationDegrees = solarElevation(start + sourceMs, gps.lat, gps.lng);
    const phase: SolarPhase = elevationDegrees > 6 ? 'day' : elevationDegrees >= -0.833 ? 'low-sun'
      : elevationDegrees >= -6 ? 'civil-twilight' : 'night';
    return { sourceMs, at: new Date(start + sourceMs).toISOString(), elevationDegrees, phase };
  });
  const days = new Map(samples.map(s => { const d = solarDay(Date.parse(s.at), gps.lat, gps.lng); return [d.solarDate, d]; }));
  return { ...base, status: 'available', gps, samples, days: [...days.values()] };
}
