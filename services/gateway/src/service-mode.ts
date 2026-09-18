/**
 * Service Mode & After-Hours Schedule Manager
 * Sesuai spec/07-mode-luar-jam.md
 */

export interface MarketSchedule {
  code: string;
  name: string;
  timezone: string;
  hours_start: string; // e.g. "09:00:00"
  hours_end: string;   // e.g. "22:00:00"
  weekend_days: number[]; // ISO: 1=Mon, ..., 7=Sun. Default [6, 7]
  city: string;
}

export interface ServiceModeInfo {
  service_mode: 'business_hours' | 'after_hours';
  next_open_time: string; // e.g. "09.00"
  city: string;
  timezone: string;
}

export const DEFAULT_MARKET_CITIES: Record<string, string> = {
  ID: 'Jakarta',
  TH: 'Bangkok',
  VN: 'Ho Chi Minh',
  PH: 'Manila',
  MY: 'Kuala Lumpur',
  SG: 'Singapore',
};

export const DEFAULT_MARKET_SCHEDULES: Record<string, MarketSchedule> = {
  ID: {
    code: 'ID',
    name: 'Indonesia',
    timezone: 'Asia/Jakarta',
    hours_start: '09:00:00',
    hours_end: '22:00:00',
    weekend_days: [6, 7],
    city: 'Jakarta',
  },
  TH: {
    code: 'TH',
    name: 'Thailand',
    timezone: 'Asia/Bangkok',
    hours_start: '09:00:00',
    hours_end: '22:00:00',
    weekend_days: [6, 7],
    city: 'Bangkok',
  },
  VN: {
    code: 'VN',
    name: 'Vietnam',
    timezone: 'Asia/Ho_Chi_Minh',
    hours_start: '09:00:00',
    hours_end: '22:00:00',
    weekend_days: [6, 7],
    city: 'Ho Chi Minh',
  },
  PH: {
    code: 'PH',
    name: 'Philippines',
    timezone: 'Asia/Manila',
    hours_start: '09:00:00',
    hours_end: '22:00:00',
    weekend_days: [6, 7],
    city: 'Manila',
  },
  MY: {
    code: 'MY',
    name: 'Malaysia',
    timezone: 'Asia/Kuala_Lumpur',
    hours_start: '09:00:00',
    hours_end: '22:00:00',
    weekend_days: [6, 7],
    city: 'Kuala Lumpur',
  },
  SG: {
    code: 'SG',
    name: 'Singapore',
    timezone: 'Asia/Singapore',
    hours_start: '09:00:00',
    hours_end: '22:00:00',
    weekend_days: [6, 7],
    city: 'Singapore',
  },
};

/**
 * Menghitung service_mode ('business_hours' | 'after_hours') berdasarkan
 * zona waktu pasar (spec/07-mode-luar-jam.md).
 * Dihitung menurut markets.timezone, bukan zona waktu kantor.
 */
export function calculateServiceMode(
  scheduleInput?: Partial<MarketSchedule> | null,
  now: Date = new Date()
): ServiceModeInfo {
  const code = (scheduleInput?.code || 'ID').toUpperCase();
  const defaultSched = DEFAULT_MARKET_SCHEDULES[code] || DEFAULT_MARKET_SCHEDULES.ID;

  const timezone = scheduleInput?.timezone || defaultSched.timezone;
  const hoursStart = scheduleInput?.hours_start || defaultSched.hours_start;
  const hoursEnd = scheduleInput?.hours_end || defaultSched.hours_end;
  const weekendDays = scheduleInput?.weekend_days || defaultSched.weekend_days;
  const city = scheduleInput?.city || DEFAULT_MARKET_CITIES[code] || defaultSched.city;

  // Format waktu lokal pasar
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const hour = parseInt(partMap.hour || '0', 10);
  const minute = parseInt(partMap.minute || '0', 10);
  const weekdayStr = (partMap.weekday || '').toLowerCase();

  // Konversi weekday ke ISO (1=Mon, ..., 7=Sun)
  const weekdayMap: Record<string, number> = {
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
    sun: 7,
  };
  const weekdayIso = weekdayMap[weekdayStr] || 1;

  // Parse start & end times
  const [startHour, startMin] = hoursStart.split(':').map((x) => parseInt(x, 10));
  const [endHour, endMin] = hoursEnd.split(':').map((x) => parseInt(x, 10));

  const currentMinutes = hour * 60 + minute;
  const startMinutes = (startHour || 9) * 60 + (startMin || 0);
  const endMinutes = (endHour || 22) * 60 + (endMin || 0);

  const isWeekend = weekendDays.includes(weekdayIso);
  const isOutsideHours = currentMinutes < startMinutes || currentMinutes >= endMinutes;

  const isAfterHours = isWeekend || isOutsideHours;

  const formattedStart = `${String(startHour || 9).padStart(2, '0')}.00`;

  return {
    service_mode: isAfterHours ? 'after_hours' : 'business_hours',
    next_open_time: formattedStart,
    city,
    timezone,
  };
}
