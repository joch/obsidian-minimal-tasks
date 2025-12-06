import { ordinalNumber, ordinalSuffix } from '../utils';

/**
 * Parse RRULE string into key-value pairs
 */
export function parseRRule(rrule: string): Record<string, string> {
	const parts: Record<string, string> = {};
	const segments = rrule.split(';');

	segments.forEach(segment => {
		const [key, value] = segment.split(':').length === 2
			? segment.split(':')
			: segment.split('=');
		if (key && value) {
			parts[key] = value;
		}
	});

	return parts;
}

/**
 * Format RRULE as human-readable text
 */
export function formatRRuleReadable(rrule: string): string {
	if (!rrule) return "";

	try {
		const parts = parseRRule(rrule);
		const freq = parts.FREQ;
		const interval = parseInt(parts.INTERVAL || '1');
		const byDay = parts.BYDAY;
		const byMonthDay = parts.BYMONTHDAY;
		const byMonth = parts.BYMONTH;
		const bySetPos = parts.BYSETPOS;

		let text = "";

		// Frequency
		if (interval === 1) {
			switch (freq) {
				case 'DAILY': text = "Daily"; break;
				case 'WEEKLY': text = "Weekly"; break;
				case 'MONTHLY': text = "Monthly"; break;
				case 'YEARLY': text = "Yearly"; break;
			}
		} else if (freq === 'MONTHLY' && interval === 3) {
			text = "Quarterly";
		} else if (freq === 'MONTHLY' && interval === 6) {
			text = "Biannually";
		} else {
			switch (freq) {
				case 'DAILY': text = `Every ${interval} days`; break;
				case 'WEEKLY': text = `Every ${interval} weeks`; break;
				case 'MONTHLY': text = `Every ${interval} months`; break;
				case 'YEARLY': text = `Every ${interval} years`; break;
			}
		}

		// Add specifics
		// Handle positional weekday (BYSETPOS + BYDAY) for monthly/yearly
		if (bySetPos && byDay) {
			const days: Record<string, string> = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
			const dayName = days[byDay] || byDay;
			const position = parseInt(bySetPos);
			const positionText = position === -1 ? "last" : ordinalNumber(position);
			text += ` on the ${positionText} ${dayName}`;
		} else if (byDay) {
			// Regular BYDAY (for weekly patterns, etc.)
			const dayNames = byDay.split(',').map((code: string) => {
				const days: Record<string, string> = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
				return days[code] || code;
			});
			text += " on " + dayNames.join(', ');
		}

		if (byMonthDay) {
			text += " on the " + byMonthDay + ordinalSuffix(parseInt(byMonthDay));
		}

		if (byMonth) {
			const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
			text += " in " + monthNames[parseInt(byMonth)];
		}

		return text;

	} catch (error) {
		console.error("Failed to format RRULE:", error);
		return "Recurring"; // Fall back to simple text
	}
}
