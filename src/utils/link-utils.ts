/**
 * Extract display name from a wikilink
 * Handles: [[Page Name]], [[path/Page Name]], [[path/Page|Display]]
 */
export function extractDisplayName(link: any): string {
	if (!link) return link;

	// Convert to string if it's not already (handles Dataview Link objects)
	const linkStr = String(link);

	// Extract from [[Page Name]] or [[path/Page Name|Display]]
	const match = linkStr.match(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/);
	if (match) return match[1];

	// Not a wikilink, return as-is
	return linkStr;
}

/**
 * Extract the link path from a wikilink
 * Handles: [[path/Page Name]], [[path/Page Name|Display]]
 */
export function extractLinkPath(link: any): string | null {
	if (!link) return null;

	// Convert to string if it's not already (handles Dataview Link objects)
	const linkStr = String(link);

	// Extract path from [[path/Page Name]] or [[path/Page Name|Display]]
	const match = linkStr.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
	if (match) return match[1];

	return null;
}

/**
 * Strip date/time prefix from event names
 * Events are named "YYYY-MM-DD HHMM Event Name" - this strips the prefix
 */
export function stripEventPrefix(eventName: string): string {
	if (!eventName) return eventName;
	// Strip "YYYY-MM-DD HHMM " prefix if present
	return eventName.replace(/^\d{4}-\d{2}-\d{2} \d{4} /, '');
}
