export interface ILocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface IFormattedZonedDateTime {
  date: string;
  time: string;
  hourMinute: string;
  parts: ILocalDateTimeParts;
}

const CDATE_PARTS = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/;
const CTIME_PARTS = /^(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?$/;
const COFFSET_TIMEZONE = /^(?<sign>[+-])(?<hour>\d{2}):(?<minute>\d{2})$/;

export function convertLocalDateTimeToIso(
  date: string,
  time: string,
  timeZone?: string,
): string | null {
  const dateParts = parseDateParts(date);
  const timeParts = parseTimeParts(time);
  if (!dateParts || !timeParts) return null;

  const localParts: ILocalDateTimeParts = {
    ...dateParts,
    ...timeParts,
  };

  if (!timeZone) {
    return buildUtcIso(localParts);
  }

  const trimmedTimezone = timeZone.trim();
  const offsetMinutes = parseOffsetTimezoneMinutes(trimmedTimezone);
  if (offsetMinutes != null) {
    return buildOffsetIso(localParts, offsetMinutes);
  }

  if (!isValidTimeZone(trimmedTimezone)) {
    return null;
  }

  const desiredUtcMs = Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
    localParts.hour,
    localParts.minute,
    localParts.second,
  );

  let guessMs = desiredUtcMs;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const zoned = formatDateInTimeZone(new Date(guessMs).toISOString(), trimmedTimezone);
    if (!zoned) return null;

    const observedUtcMs = Date.UTC(
      zoned.parts.year,
      zoned.parts.month - 1,
      zoned.parts.day,
      zoned.parts.hour,
      zoned.parts.minute,
      zoned.parts.second,
    );
    const diffMs = desiredUtcMs - observedUtcMs;
    guessMs += diffMs;

    if (diffMs === 0) {
      return new Date(guessMs).toISOString();
    }
  }

  const final = formatDateInTimeZone(new Date(guessMs).toISOString(), trimmedTimezone);
  if (!final) return null;
  if (
    final.parts.year !== localParts.year
    || final.parts.month !== localParts.month
    || final.parts.day !== localParts.day
    || final.parts.hour !== localParts.hour
    || final.parts.minute !== localParts.minute
  ) {
    return null;
  }

  return new Date(guessMs).toISOString();
}

export function formatDateInTimeZone(
  iso: string,
  timeZone: string,
): IFormattedZonedDateTime | null {
  const offsetMinutes = parseOffsetTimezoneMinutes(timeZone);
  if (offsetMinutes != null) {
    const shifted = new Date(new Date(iso).getTime() + offsetMinutes * 60_000).toISOString();
    return formatDateInTimeZoneWithIntl(shifted, 'UTC');
  }

  return formatDateInTimeZoneWithIntl(iso, timeZone);
}

function formatDateInTimeZoneWithIntl(
  iso: string,
  timeZone: string,
): IFormattedZonedDateTime | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(iso));
    const lookup = new Map(parts.map(part => [part.type, part.value]));
    const year = Number(lookup.get('year'));
    const month = Number(lookup.get('month'));
    const day = Number(lookup.get('day'));
    const hour = Number(lookup.get('hour'));
    const minute = Number(lookup.get('minute'));
    const second = Number(lookup.get('second'));
    if ([year, month, day, hour, minute, second].some(value => !Number.isFinite(value))) {
      return null;
    }

    const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    const hourMinute = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return {
      date,
      time,
      hourMinute,
      parts: {
        year,
        month,
        day,
        hour,
        minute,
        second,
      },
    };
  } catch {
    return null;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  if (parseOffsetTimezoneMinutes(timeZone) != null) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function parseDateParts(date: string): Pick<ILocalDateTimeParts, 'year' | 'month' | 'day'> | null {
  const match = date.trim().match(CDATE_PARTS);
  if (!match?.groups) return null;

  const year = Number(match.groups['year']);
  const month = Number(match.groups['month']);
  const day = Number(match.groups['day']);
  if ([year, month, day].some(value => !Number.isFinite(value))) return null;

  return { year, month, day };
}

function parseTimeParts(time: string): Pick<ILocalDateTimeParts, 'hour' | 'minute' | 'second'> | null {
  const match = time.trim().match(CTIME_PARTS);
  if (!match?.groups) return null;

  const hour = Number(match.groups['hour']);
  const minute = Number(match.groups['minute']);
  const second = Number(match.groups['second'] ?? '0');
  if ([hour, minute, second].some(value => !Number.isFinite(value))) return null;

  return { hour, minute, second };
}

function buildUtcIso(parts: ILocalDateTimeParts): string {
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )).toISOString();
}

function buildOffsetIso(parts: ILocalDateTimeParts, offsetMinutes: number): string {
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute - offsetMinutes,
    parts.second,
  )).toISOString();
}

function parseOffsetTimezoneMinutes(timeZone: string): number | null {
  const match = timeZone.trim().match(COFFSET_TIMEZONE);
  if (!match?.groups) return null;

  const hour = Number(match.groups['hour']);
  const minute = Number(match.groups['minute']);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const sign = match.groups['sign'] === '-' ? -1 : 1;
  return sign * (hour * 60 + minute);
}
