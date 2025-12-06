/**
 * Format a Date to "Mon DD" format
 */
export function formatDate(date: Date): string {
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `${months[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Format a date string to RRULE DTSTART format (YYYYMMDD)
 */
export function formatDTSTART(dateStr: string): string {
	const d = new Date(dateStr);
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${year}${month}${day}`;
}

/**
 * Format a date value for HTML date input (YYYY-MM-DD)
 * Handles Luxon DateTime or ISO strings
 */
export function formatDateForInput(dateValue: any): string {
	if (!dateValue) return '';
	const str = String(dateValue).replace(/^["']|["']$/g, '');
	// Handle Luxon DateTime or ISO string
	if (str.length >= 10) {
		return str.substring(0, 10);
	}
	return '';
}
