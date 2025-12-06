import { ParsedContent, Frontmatter } from '../types';

/**
 * Parse frontmatter and body from file content
 */
export function parseFrontmatter(content: string): ParsedContent {
	const regex = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
	const match = content.match(regex);

	if (!match) {
		return { frontmatter: {}, body: content };
	}

	const frontmatterText = match[1];
	const body = match[2];

	// Parse YAML frontmatter into object
	const frontmatter: Frontmatter = {};
	const lines = frontmatterText.split('\n');

	let currentKey: string | null = null;
	let currentArray: string[] | null = null;

	for (const line of lines) {
		// Array item
		if (line.trim().startsWith('- ')) {
			if (currentArray) {
				currentArray.push(line.trim().substring(2));
			}
			continue;
		}

		// Key-value pair
		const colonIndex = line.indexOf(':');
		if (colonIndex > 0) {
			const key = line.substring(0, colonIndex).trim();
			const value = line.substring(colonIndex + 1).trim();

			currentKey = key;

			// Empty value might indicate array
			if (value === '') {
				currentArray = [];
				frontmatter[key] = currentArray;
			} else {
				frontmatter[key] = value;
				currentArray = null;
			}
		}
	}

	return { frontmatter, body };
}

/**
 * Rebuild file content from frontmatter and body
 */
export function rebuildContent(frontmatter: Frontmatter, body: string): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(frontmatter)) {
		if (Array.isArray(value)) {
			if (value.length === 0) {
				// Empty array - output as []
				lines.push(`${key}: []`);
			} else {
				lines.push(`${key}:`);
				value.forEach(item => {
					lines.push(`  - ${item}`);
				});
			}
		} else {
			lines.push(`${key}: ${value}`);
		}
	}

	const frontmatterText = lines.join('\n');
	return `---\n${frontmatterText}\n---\n${body}`;
}
