/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
	const div = document.createElement('div');
	div.textContent = text;
	return div.textContent || '';
}

/**
 * Generate timestamp for action filenames
 * Format: YYYYMMDD-HHMMSS
 */
export function generateTimestamp(): string {
	const now = new Date();
	const pad = (n: number) => n.toString().padStart(2, '0');
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Get ordinal suffix for a number (st, nd, rd, th)
 */
export function ordinalSuffix(num: number): string {
	const j = num % 10;
	const k = num % 100;
	if (j === 1 && k !== 11) return "st";
	if (j === 2 && k !== 12) return "nd";
	if (j === 3 && k !== 13) return "rd";
	return "th";
}

/**
 * Format a number with its ordinal suffix (1st, 2nd, 3rd, etc.)
 */
export function ordinalNumber(num: number): string {
	return num + ordinalSuffix(num);
}
