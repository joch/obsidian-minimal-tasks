import { parseRRule } from './rrule-parser';

/**
 * Convert day code to number (0=Sunday, 6=Saturday)
 */
export function dayCodeToNumber(code: string): number {
	const days: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
	return days[code] || 0;
}

/**
 * Calculate next occurrence using RRULE
 * This is a simplified implementation - uses the same logic as recurrence_calculator.js
 */
export function calculateNextOccurrence(rrule: string, afterDate: string): string {
	const parts = parseRRule(rrule);
	const after = new Date(afterDate);
	after.setDate(after.getDate() + 1); // Start from tomorrow

	// Parse start date from DTSTART
	const dtstart = parts.DTSTART;
	if (!dtstart) throw new Error('DTSTART is required in RRULE');

	const startDate = new Date(
		parseInt(dtstart.substring(0, 4)),
		parseInt(dtstart.substring(4, 6)) - 1,
		parseInt(dtstart.substring(6, 8))
	);

	const freq = parts.FREQ;
	if (!freq) throw new Error('FREQ is required in RRULE');

	const interval = parseInt(parts.INTERVAL || '1');

	let next: Date;

	switch (freq) {
		case 'DAILY':
			next = new Date(after);
			if (parts.BYDAY) {
				// Specific days of week (e.g., weekdays)
				const allowedDays = parts.BYDAY.split(',').map(dayCodeToNumber);
				while (!allowedDays.includes(next.getDay())) {
					next.setDate(next.getDate() + 1);
				}
			} else {
				// Every N days from start date
				const daysSinceStart = Math.floor((next.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
				const remainder = daysSinceStart % interval;
				if (remainder !== 0) {
					next.setDate(next.getDate() + (interval - remainder));
				}
			}
			break;

		case 'WEEKLY':
			next = new Date(after);
			const byDay = parts.BYDAY || ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][startDate.getDay()];
			const allowedDays = byDay.split(',').map(dayCodeToNumber);

			// Find next occurrence of allowed day
			let found = false;
			for (let i = 0; i < 7 && !found; i++) {
				if (allowedDays.includes(next.getDay())) {
					if (interval === 1) {
						found = true;
						break;
					}
					const weeksSinceStart = Math.floor((next.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 7));
					if (weeksSinceStart % interval === 0) {
						found = true;
						break;
					}
				}
				next.setDate(next.getDate() + 1);
			}

			if (!found) {
				// Advance to next interval week
				next = new Date(after);
				next.setDate(next.getDate() + (interval * 7));
				while (!allowedDays.includes(next.getDay())) {
					next.setDate(next.getDate() + 1);
				}
			}
			break;

		case 'MONTHLY':
			next = new Date(after);
			const dayOfMonth = parts.BYMONTHDAY ? parseInt(parts.BYMONTHDAY) : startDate.getDate();
			next.setDate(dayOfMonth);

			if (next <= after) {
				next.setMonth(next.getMonth() + interval);
			} else {
				const monthsSinceStart = (next.getFullYear() - startDate.getFullYear()) * 12 + (next.getMonth() - startDate.getMonth());
				if (monthsSinceStart % interval !== 0) {
					const remainder = monthsSinceStart % interval;
					next.setMonth(next.getMonth() + (interval - remainder));
				}
			}

			// Handle months with fewer days
			while (next.getDate() !== dayOfMonth) {
				next.setDate(0); // Go to last day of previous month
				next.setMonth(next.getMonth() + 1);
			}
			break;

		case 'YEARLY':
			next = new Date(after);
			const month = parts.BYMONTH ? parseInt(parts.BYMONTH) - 1 : startDate.getMonth();
			const day = parts.BYMONTHDAY ? parseInt(parts.BYMONTHDAY) : startDate.getDate();
			next.setMonth(month);
			next.setDate(day);

			if (next <= after) {
				next.setFullYear(next.getFullYear() + interval);
			} else {
				const yearsSinceStart = next.getFullYear() - startDate.getFullYear();
				if (yearsSinceStart % interval !== 0) {
					const remainder = yearsSinceStart % interval;
					next.setFullYear(next.getFullYear() + (interval - remainder));
				}
			}
			break;

		default:
			throw new Error('Unsupported FREQ: ' + freq);
	}

	// Format as YYYY-MM-DD
	const year = next.getFullYear();
	const monthStr = String(next.getMonth() + 1).padStart(2, '0');
	const dayStr = String(next.getDate()).padStart(2, '0');
	return `${year}-${monthStr}-${dayStr}`;
}
