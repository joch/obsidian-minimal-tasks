import { escapeHtml, extractDisplayName, extractLinkPath, stripEventPrefix } from '../utils';
import { formatRRuleReadable } from '../recurrence';

/**
 * Get icon for priority value
 */
export function getPriorityIcon(priority: string): string {
	const icons: { [key: string]: string } = {
		'today': '⭐',
		'someday': '💭',
		'anytime': '•'  // Simple bullet - minimal like Things 3
	};
	return icons[priority] || '•';
}

/**
 * Render status dot HTML
 */
export function renderStatusDot(status: string, path: string): string {
	return `<span class="task-status-dot" data-status="${status}" data-task-path="${path}" title="Status: ${status} (click to cycle)"></span>`;
}

/**
 * Render priority badge HTML
 */
export function renderPriorityBadge(priority: string, path: string): string {
	const icon = getPriorityIcon(priority);
	return `<span class="task-priority-badge" data-priority="${priority}" data-task-path="${path}" title="Priority: ${priority} (click to cycle)">${icon}</span>`;
}

/**
 * Render context pills HTML
 */
export function renderContextPills(contexts: string | string[]): string {
	return (Array.isArray(contexts) ? contexts : [contexts])
		.map(ctx => `<span class="minimal-badge minimal-badge-context">@${ctx}</span>`)
		.join('');
}

/**
 * Render discuss-with pills HTML
 */
export function renderDiscussWithPills(discussWith: string | string[]): string {
	return (Array.isArray(discussWith) ? discussWith : [discussWith])
		.map(person => {
			const displayName = extractDisplayName(person);
			const linkPath = extractLinkPath(person);

			if (linkPath) {
				return `<span class="minimal-badge minimal-badge-person"><a class="internal-link" data-href="${linkPath}" href="${linkPath}" target="_blank" rel="noopener">👤${displayName}</a></span>`;
			}
			return `<span class="minimal-badge minimal-badge-person">👤${displayName}</span>`;
		})
		.join('');
}

/**
 * Render discuss-during pills HTML
 */
export function renderDiscussDuringPills(discussDuring: string | string[]): string {
	return (Array.isArray(discussDuring) ? discussDuring : [discussDuring])
		.map(event => {
			const displayName = extractDisplayName(event);
			const cleanName = stripEventPrefix(displayName);
			return `<span class="minimal-badge minimal-badge-meeting">📅${cleanName}</span>`;
		})
		.join('');
}

/**
 * Render store pill HTML
 */
export function renderStorePill(store: string): string {
	return `<span class="minimal-badge minimal-badge-store">🏪${store}</span>`;
}

/**
 * Render recurrence pill HTML
 */
export function renderRecurrencePill(rrule: string): string {
	const readable = formatRRuleReadable(rrule);
	return `<span class="minimal-badge minimal-badge-recurrence">🔁 ${readable}</span>`;
}

/**
 * Render project pills HTML
 */
export function renderProjectPills(projects: string | string[]): string {
	return (Array.isArray(projects) ? projects : [projects])
		.filter(p => p)
		.map(project => {
			const displayName = extractDisplayName(project);
			const linkPath = extractLinkPath(project);
			if (linkPath) {
				return `<span class="minimal-badge minimal-badge-project"><a class="internal-link" data-href="${linkPath}" href="${linkPath}">📁 ${escapeHtml(displayName)}</a></span>`;
			}
			return `<span class="minimal-badge minimal-badge-project">📁 ${escapeHtml(displayName)}</span>`;
		})
		.join('');
}
