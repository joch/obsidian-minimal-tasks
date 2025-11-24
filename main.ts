import { App, Plugin, PluginSettingTab, Setting, Menu, Notice, TFile, TAbstractFile } from 'obsidian';
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { Range } from '@codemirror/state';

// Interfaces for settings and data structures
interface MinimalTasksSettings {
	// Field names (customizable for different vaults)
	projectField: string;
	dueField: string;
	scheduledField: string;
	contextsField: string;
	discussWithField: string;
	discussDuringField: string;
	storeField: string;
	areaField: string;
	titleField: string;
	statusField: string;
	priorityField: string;
	rruleField: string;

	// Display options
	showProjects: boolean;
	showProjectDueDates: boolean;
	showNoteIcon: boolean;
	showContextPills: boolean;
	noteContentIgnorePattern: string;
	enableConvertIcon: boolean;

	// Status and priority values
	statuses: string[];
	priorities: string[];
}

const DEFAULT_SETTINGS: MinimalTasksSettings = {
	// Field names (customizable for different vaults)
	projectField: 'projects',
	dueField: 'due',
	scheduledField: 'scheduled',
	contextsField: 'contexts',
	discussWithField: 'discuss-with',
	discussDuringField: 'discuss-during',
	storeField: 'store',
	areaField: 'area',
	titleField: 'title',
	statusField: 'status',
	priorityField: 'priority',
	rruleField: 'rrule',

	// Display options
	showProjects: true,
	showProjectDueDates: true,
	showNoteIcon: true,
	showContextPills: false,  // Usually hidden in context views
	noteContentIgnorePattern: '^\\s*```dataviewjs\\s*\\n\\s*await dv\\.view\\("(?:apps\\/dataview\\/)?unified-ribbon"\\);?\\s*\\n\\s*```\\s*',
	enableConvertIcon: true,

	// Status and priority values
	statuses: ['none', 'open', 'in-progress', 'done', 'dropped'],
	priorities: ['anytime', 'today', 'someday']
};

interface DataviewAPI {
	fileLink: (path: string, embed?: boolean, display?: string) => string;
	page: (path: string) => any;
	date: (dateStr: string) => any;
}

interface TaskFile {
	path: string;
	ctime?: number;
}

interface EnrichedTask {
	status: string;
	priority: string;
	link: string;
	file: TaskFile;
	contexts?: string[];
	'discuss-with'?: string[];
	'discuss-during'?: string[];
	store?: string;
	due?: string;
	scheduled?: string;
	rrule?: string;
	projects?: any[];
	projectsWithMeta?: ProjectMeta[];
}

interface ProjectMeta {
	link: string;
	due?: string;
	dueFormatted?: string;
	overdue?: boolean;
}

interface ProcessedTask {
	task: any;
	hasNotes: boolean;
	enrichedTask: EnrichedTask;
}

interface RenderOptions {
	hasNotes?: boolean;
	showProjects?: boolean;
	showContexts?: boolean;
	excludePills?: string[];
}

interface Frontmatter {
	[key: string]: any;
}

interface ParsedContent {
	frontmatter: Frontmatter;
	body: string;
}

interface StatusOption {
	value: string;
	label: string;
	icon: string;
}

interface PriorityOption {
	value: string;
	label: string;
	icon: string;
}

// Extend Window interface to include MinimalTasks
declare global {
	interface Window {
		MinimalTasks?: {
			renderTask: (task: EnrichedTask, options?: RenderOptions) => string;
			renderTaskList: (dv: DataviewAPI, tasks: any[] | any, options?: RenderOptions) => Promise<string>;
			settings: MinimalTasksSettings;
		};
	}
}

// Widget for the convert-to-action icon
class ConvertTaskWidget extends WidgetType {
	constructor(
		private plugin: MinimalTasksPlugin,
		private taskText: string,
		private lineFrom: number,
		private lineTo: number
	) {
		super();
	}

	toDOM(view: EditorView): HTMLElement {
		const icon = document.createElement('span');
		icon.className = 'minimal-tasks-convert-icon';
		icon.textContent = '➕';
		icon.title = 'Convert to action';
		icon.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.plugin.convertToAction(this.taskText, this.lineFrom, this.lineTo, view);
		});
		return icon;
	}

	eq(other: ConvertTaskWidget): boolean {
		return this.taskText === other.taskText && this.lineFrom === other.lineFrom;
	}
}

// ViewPlugin factory for task line decoration
function createConvertTaskPlugin(plugin: MinimalTasksPlugin) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = this.buildDecorations(view);
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = this.buildDecorations(update.view);
				}
			}

			buildDecorations(view: EditorView): DecorationSet {
				const widgets: Range<Decoration>[] = [];
				// Match uncompleted markdown tasks: - [ ] task text
				const taskRegex = /^(\s*)- \[ \] (.+)$/;

				for (const { from, to } of view.visibleRanges) {
					for (let pos = from; pos <= to;) {
						const line = view.state.doc.lineAt(pos);
						const match = line.text.match(taskRegex);
						if (match && match[2]) {
							const widget = Decoration.widget({
								widget: new ConvertTaskWidget(plugin, match[2], line.from, line.to),
								side: 1
							});
							widgets.push(widget.range(line.to));
						}
						pos = line.to + 1;
					}
				}
				return Decoration.set(widgets, true);
			}
		},
		{ decorations: v => v.decorations }
	);
}

export default class MinimalTasksPlugin extends Plugin {
	settings: MinimalTasksSettings;

	async onload(): Promise<void> {
		console.log('Loading Minimal Tasks plugin');

		// Load settings
		await this.loadSettings();

		// Expose rendering functions globally for DataviewJS
		window.MinimalTasks = {
			renderTask: this.renderTask.bind(this),
			renderTaskList: this.renderTaskList.bind(this),
			settings: this.settings
		};

		// Register global click handler (event delegation)
		this.registerDomEvent(document, 'click', this.handleClick.bind(this));

		// Register context menu handler for right-click
		this.registerDomEvent(document, 'contextmenu', this.handleContextMenu.bind(this));

		// Add settings tab
		this.addSettingTab(new MinimalTasksSettingTab(this.app, this));

		// Register CodeMirror extension for convert icons (if enabled)
		if (this.settings.enableConvertIcon) {
			this.registerEditorExtension(createConvertTaskPlugin(this));
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Update global reference
		if (window.MinimalTasks) {
			window.MinimalTasks.settings = this.settings;
		}
	}

	/**
	 * Render a list of tasks with automatic enrichment
	 * Main API for users - accepts raw Dataview page objects
	 * @param dv - Dataview API object
	 * @param tasks - Array of Dataview page objects (tasks)
	 * @param options - Rendering options
	 * @returns HTML string with all tasks
	 */
	async renderTaskList(dv: DataviewAPI, tasks: any[] | any, options: RenderOptions = {}): Promise<string> {
		// Convert DataArray to regular array if needed
		const taskArray: any[] = Array.isArray(tasks) ? tasks : tasks.array();

		// Process each task: check for notes, enrich metadata
		const processedTasks: ProcessedTask[] = await Promise.all(taskArray.map(async (task: any): Promise<ProcessedTask> => {
			return {
				task,
				hasNotes: await this.hasNoteContent(task.file),
				enrichedTask: await this.enrichTaskData(dv, task)
			};
		}));

		// Sort tasks
		const sortedTasks = this.sortTasks(processedTasks.map(p => p.task));

		// Render each task
		const taskHtmlArray = sortedTasks.map(task => {
			const processedTask = processedTasks.find(p => p.task.file.path === task.file.path);
			if (!processedTask) return '';
			return this.renderTask(processedTask.enrichedTask, {
				...options,
				hasNotes: processedTask.hasNotes
			});
		});

		// Join with line breaks
		return taskHtmlArray.join('<br>');
	}

	/**
	 * Enrich task data with links and project metadata
	 * @param dv - Dataview API object
	 * @param task - Raw Dataview page object
	 * @returns Enriched task data
	 */
	async enrichTaskData(dv: DataviewAPI, task: any): Promise<EnrichedTask> {
		// Generate link - build HTML manually instead of using dv.fileLink()
		const title = task[this.settings.titleField];
		const displayText = title || task.file.name.replace(/\.md$/, '');
		const taskLink = `<a data-href="${task.file.path}" href="${task.file.path}" class="internal-link" target="_blank" rel="noopener">${displayText}</a>`;

		// Enrich project metadata with due dates
		let projectsWithMeta: ProjectMeta[] | undefined = undefined;
		const projects = task[this.settings.projectField];
		if (projects && projects.length > 0) {
			projectsWithMeta = projects.map((project: any): ProjectMeta => {
				// Convert Link object to string if needed
				const projectLink = typeof project === 'string' ? project : String(project);

				// Extract the path from wikilink [[path|display]] or [[path]]
				const match = projectLink.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
				if (!match) return { link: projectLink };

				const projectPath = match[1];
				const displayText = match[2] || projectPath.split('/').pop()?.replace(/\.md$/, '') || projectPath;

				// Build HTML link
				const htmlLink = `<a data-href="${projectPath}" href="${projectPath}" class="internal-link" target="_blank" rel="noopener">${displayText}</a>`;

				const projectPage = dv.page(projectPath);

				if (!projectPage) return { link: htmlLink };

				// Add due date metadata if exists
				if (projectPage[this.settings.dueField]) {
					const dueDate = dv.date(projectPage[this.settings.dueField]);
					const today = dv.date('today');
					const formattedDate = dueDate.toFormat('MMM dd');

					return {
						link: htmlLink,
						due: projectPage[this.settings.dueField],
						dueFormatted: formattedDate,
						overdue: dueDate < today
					};
				}

				return { link: htmlLink };
			});
		}

		// Return enriched task data
		return {
			status: task[this.settings.statusField],
			priority: task[this.settings.priorityField],
			link: taskLink,
			file: { path: task.file.path },
			contexts: task[this.settings.contextsField],
			'discuss-with': task[this.settings.discussWithField],
			'discuss-during': task[this.settings.discussDuringField],
			store: task[this.settings.storeField],
			due: task[this.settings.dueField],
			scheduled: task[this.settings.scheduledField],
			rrule: task[this.settings.rruleField],
			projects: projects,
			projectsWithMeta: projectsWithMeta
		};
	}

	/**
	 * Check if a task file has note content (beyond frontmatter)
	 * @param file - Dataview file metadata object or Obsidian file object
	 * @returns True if task has notes
	 */
	async hasNoteContent(file: any): Promise<boolean> {
		try {
			// Get the actual Obsidian file object from path
			// file could be either a Dataview metadata object or an Obsidian TFile
			const filePath = file.path || file.file?.path;
			if (!filePath) return false;

			const tFile = this.app.vault.getAbstractFileByPath(filePath);
			if (!tFile || !(tFile instanceof TFile)) return false;

			const content = await this.app.vault.read(tFile);

			// Remove frontmatter (everything between first --- and second ---)
			const frontmatterRegex = /^---\n[\s\S]*?\n---\n/;
			let remainingContent = content.replace(frontmatterRegex, '').trim();

			// Remove content matching the ignore pattern (e.g., ribbon blocks)
			if (this.settings.noteContentIgnorePattern) {
				try {
					const ignoreRegex = new RegExp(this.settings.noteContentIgnorePattern);
					remainingContent = remainingContent.replace(ignoreRegex, '').trim();
				} catch (error) {
					console.error('Invalid noteContentIgnorePattern regex:', error);
				}
			}

			// Check if there's any non-whitespace content after removing both frontmatter and ribbon
			return remainingContent.length > 0;
		} catch (error) {
			return false;
		}
	}

	/**
	 * Sort tasks by standard criteria
	 * @param tasks - Array of tasks to sort
	 * @returns Sorted array of tasks
	 */
	sortTasks(tasks: any[]): any[] {
		return tasks.sort((a: any, b: any) => {
			const statusField = this.settings.statusField;
			const priorityField = this.settings.priorityField;
			const dueField = this.settings.dueField;

			// 1. In-progress tasks first
			const aInProgress = a[statusField] === "in-progress";
			const bInProgress = b[statusField] === "in-progress";
			if (aInProgress && !bInProgress) return -1;
			if (!aInProgress && bInProgress) return 1;

			// 2. Priority: today tasks next
			const aTodayPriority = a[priorityField] === "today";
			const bTodayPriority = b[priorityField] === "today";
			if (aTodayPriority && !bTodayPriority) return -1;
			if (!aTodayPriority && bTodayPriority) return 1;

			// 3. Tasks with due dates next
			const aDue = a[dueField];
			const bDue = b[dueField];
			if (aDue && !bDue) return -1;
			if (!aDue && bDue) return 1;
			if (aDue && bDue) {
				if (aDue < bDue) return -1;
				if (aDue > bDue) return 1;
			}

			// 4. Finally, oldest first
			return a.file.ctime - b.file.ctime;
		});
	}

	/**
	 * Render a task with all metadata (comprehensive rendering)
	 * Called from renderTaskList or directly
	 * @param task - Task data with enriched metadata
	 * @param options - Rendering options
	 */
	renderTask(task: EnrichedTask, options: RenderOptions = {}): string {
		const {
			hasNotes = false,
			showProjects = true,
			showContexts = false,
			excludePills = []
		} = options;

		// Get file path
		let path: string;
		if (task.file && task.file.path) {
			path = task.file.path;
		} else if ((task as any).path) {
			path = (task as any).path;
		} else {
			console.error('MinimalTasks: No path found in task object', task);
			return 'Error: No task path';
		}

		// Get field values using configured field names
		const status = (task as any)[this.settings.statusField] || 'none';
		const priority = (task as any)[this.settings.priorityField] || 'anytime';
		const isCompleted = status === 'done' || status === 'dropped';

		// Build task row container
		const controls = this.createControls(priority, status, path);
		const content = this.createContent(task, hasNotes, isCompleted, showContexts, excludePills);
		const mainLine = this.createMainLine(controls, content);
		const projectsSection = this.createProjectsSection(task, showProjects);

		return `<div class="minimal-task-row" data-task-path="${path}" data-status="${status}" data-priority="${priority}">${mainLine}${projectsSection}</div>`;
	}

	private createControls(priority: string, status: string, path: string): string {
		return `<div class="minimal-task-controls">${this.renderPriorityBadge(priority, path)}${this.renderStatusDot(status, path)}</div>`;
	}

	private createContent(task: EnrichedTask, hasNotes: boolean, isCompleted: boolean, showContexts: boolean, excludePills: string[]): string {
		const title = this.createTitle(task, isCompleted);
		const noteIcon = hasNotes && this.settings.showNoteIcon
			? '<span class="minimal-task-note-icon">☰</span>'
			: '';
		const metadata = this.createMetadata(task, showContexts, excludePills);

		return `<div class="minimal-task-content">${title}${noteIcon}${metadata}</div>`;
	}

	private createTitle(task: EnrichedTask, isCompleted: boolean): string {
		const taskLinkHtml = task.link || 'Untitled';
		const completedClass = isCompleted ? ' is-completed' : '';
		return `<span class="minimal-task-title${completedClass}">${taskLinkHtml}</span>`;
	}

	private createMetadata(task: EnrichedTask, showContexts: boolean, excludePills: string[]): string {
		const badges: string[] = [];

		// Date badges
		const dateBadges = this.renderDateBadges(task);
		if (dateBadges) badges.push(dateBadges);

		// Recurrence pill
		const rrule = (task as any)[this.settings.rruleField];
		if (rrule && !excludePills.includes('recurrence')) {
			badges.push(this.renderRecurrencePill(rrule));
		}

		// Context pills
		const contexts = (task as any)[this.settings.contextsField] || [];
		if (showContexts && contexts.length > 0 && !excludePills.includes('contexts')) {
			badges.push(this.renderContextPills(contexts));
		}

		// Discuss-with pills
		const discussWith = (task as any)[this.settings.discussWithField];
		if (discussWith && !excludePills.includes('person')) {
			badges.push(this.renderDiscussWithPills(discussWith));
		}

		// Discuss-during pills
		const discussDuring = (task as any)[this.settings.discussDuringField];
		if (discussDuring && !excludePills.includes('meeting')) {
			badges.push(this.renderDiscussDuringPills(discussDuring));
		}

		// Store pill
		const store = (task as any)[this.settings.storeField];
		if (store && !excludePills.includes('store')) {
			badges.push(this.renderStorePill(store));
		}

		if (badges.length === 0) return '';

		return `<span class="minimal-task-metadata">${badges.join('')}</span>`;
	}

	private createMainLine(controls: string, content: string): string {
		return `<div class="minimal-task-main">${controls}${content}</div>`;
	}

	private createProjectsSection(task: EnrichedTask, showProjects: boolean): string {
		if (!this.settings.showProjects || !showProjects) return '';

		const projects = (task as any)[this.settings.projectField] || [];
		if (projects.length === 0) return '';

		const projectsWithMeta = task.projectsWithMeta || projects;
		const projectItems = projectsWithMeta.map((project: ProjectMeta | any) => {
			return this.createProjectItem(project);
		}).join('');

		return `<div class="minimal-task-projects">${projectItems}</div>`;
	}

	private createProjectItem(project: ProjectMeta | any): string {
		let projectHtml = '';

		if ((project as ProjectMeta).link) {
			const p = project as ProjectMeta;
			projectHtml = p.link;

			if (this.settings.showProjectDueDates && p.due) {
				const dueDate = p.dueFormatted || p.due;
				const badgeClass = p.overdue ? ' is-overdue' : '';
				projectHtml += ` <span class="minimal-badge minimal-badge-date${badgeClass}">📅 ${dueDate}</span>`;
			}
		} else {
			projectHtml = typeof project === 'string' ? project : String(project);
		}

		return `<div class="minimal-task-project">${projectHtml}</div>`;
	}

	// Helper rendering methods

	renderStatusDot(status: string, path: string): string {
		return `<span class="task-status-dot" data-status="${status}" data-task-path="${path}" title="Status: ${status} (click to cycle)"></span>`;
	}

	renderPriorityBadge(priority: string, path: string): string {
		const icon = this.getPriorityIcon(priority);
		return `<span class="task-priority-badge" data-priority="${priority}" data-task-path="${path}" title="Priority: ${priority} (click to cycle)">${icon}</span>`;
	}

	renderContextPills(contexts: string | string[]): string {
		return (Array.isArray(contexts) ? contexts : [contexts])
			.map(ctx => `<span class="minimal-badge minimal-badge-context">@${ctx}</span>`)
			.join('');
	}

	renderDiscussWithPills(discussWith: string | string[]): string {
		return (Array.isArray(discussWith) ? discussWith : [discussWith])
			.map(person => {
				const displayName = this.extractDisplayName(person);
				const linkPath = this.extractLinkPath(person);

				if (linkPath) {
					return `<span class="minimal-badge minimal-badge-person"><a class="internal-link" data-href="${linkPath}" href="${linkPath}" target="_blank" rel="noopener">👤${displayName}</a></span>`;
				}
				return `<span class="minimal-badge minimal-badge-person">👤${displayName}</span>`;
			})
			.join('');
	}

	/**
	 * Extract display name from a wikilink
	 * Handles: [[Page Name]], [[path/Page Name]], [[path/Page|Display]]
	 */
	extractDisplayName(link: any): string {
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
	extractLinkPath(link: any): string | null {
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
	stripEventPrefix(eventName: string): string {
		if (!eventName) return eventName;
		// Strip "YYYY-MM-DD HHMM " prefix if present
		return eventName.replace(/^\d{4}-\d{2}-\d{2} \d{4} /, '');
	}

	renderDiscussDuringPills(discussDuring: string | string[]): string {
		return (Array.isArray(discussDuring) ? discussDuring : [discussDuring])
			.map(event => {
				const displayName = this.extractDisplayName(event);
				const cleanName = this.stripEventPrefix(displayName);
				return `<span class="minimal-badge minimal-badge-meeting">📅${cleanName}</span>`;
			})
			.join('');
	}

	renderStorePill(store: string): string {
		return `<span class="minimal-badge minimal-badge-store">🏪${store}</span>`;
	}

	renderRecurrencePill(rrule: string): string {
		const readable = this.formatRRuleReadable(rrule);
		return `<span class="minimal-badge minimal-badge-recurrence">🔁 ${readable}</span>`;
	}

	private formatRRuleReadable(rrule: string): string {
		if (!rrule) return "";

		try {
			const parts = this.parseRRule(rrule);
			const freq = parts.FREQ;
			const interval = parseInt(parts.INTERVAL || '1');
			const byDay = parts.BYDAY;
			const byMonthDay = parts.BYMONTHDAY;
			const byMonth = parts.BYMONTH;

			let text = "";

			// Frequency
			if (interval === 1) {
				switch (freq) {
					case 'DAILY': text = "Daily"; break;
					case 'WEEKLY': text = "Weekly"; break;
					case 'MONTHLY': text = "Monthly"; break;
					case 'YEARLY': text = "Yearly"; break;
				}
			} else {
				switch (freq) {
					case 'DAILY': text = `Every ${interval} days`; break;
					case 'WEEKLY': text = `Every ${interval} weeks`; break;
					case 'MONTHLY': text = `Every ${interval} months`; break;
					case 'YEARLY': text = `Every ${interval} years`; break;
				}
			}

			// Add specifics
			if (byDay) {
				const dayNames = byDay.split(',').map((code: string) => {
					const days: Record<string, string> = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
					return days[code] || code;
				});
				text += " on " + dayNames.join(', ');
			}

			if (byMonthDay) {
				text += " on the " + byMonthDay + this.ordinalSuffix(parseInt(byMonthDay));
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

	private parseRRule(rrule: string): Record<string, string> {
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

	private ordinalSuffix(num: number): string {
		const j = num % 10;
		const k = num % 100;
		if (j === 1 && k !== 11) return "st";
		if (j === 2 && k !== 12) return "nd";
		if (j === 3 && k !== 13) return "rd";
		return "th";
	}

	renderDateBadges(task: EnrichedTask): string {
		const badges: string[] = [];
		const due = (task as any)[this.settings.dueField];
		const scheduled = (task as any)[this.settings.scheduledField];

		if (scheduled) {
			const scheduledDate = new Date(scheduled);
			scheduledDate.setHours(0, 0, 0, 0);
			const formattedScheduled = this.formatDate(scheduledDate);
			badges.push(`<span class="minimal-badge minimal-badge-date">🗓️ ${formattedScheduled}</span>`);
		}

		if (due) {
			const dueDate = new Date(due);
			dueDate.setHours(0, 0, 0, 0);
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const isOverdue = dueDate < today;
			const formattedDue = this.formatDate(dueDate);
			const icon = isOverdue ? '⚠️' : '📅';
			const badgeClass = isOverdue ? ' is-overdue' : '';
			badges.push(`<span class="minimal-badge minimal-badge-date${badgeClass}">${icon} ${formattedDue}</span>`);
		}

		return badges.join('');
	}

	formatDate(date: Date): string {
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		return `${months[date.getMonth()]} ${date.getDate()}`;
	}

	getPriorityIcon(priority: string): string {
		const icons: { [key: string]: string } = {
			'today': '⭐',
			'someday': '💭',
			'anytime': '•'  // Simple bullet - minimal like Things 3
		};
		return icons[priority] || '•';
	}

	/**
	 * Handle all clicks on the document (event delegation)
	 */
	async handleClick(event: MouseEvent): Promise<void> {
		const target = event.target as HTMLElement;

		// Check if clicked on status dot
		if (target.classList.contains('task-status-dot')) {
			event.preventDefault();
			event.stopPropagation();
			await this.cycleStatus(target);
			return;
		}

		// Check if clicked on priority badge
		if (target.classList.contains('task-priority-badge')) {
			event.preventDefault();
			event.stopPropagation();
			await this.cyclePriority(target);
			return;
		}
	}

	/**
	 * Handle right-click context menu
	 */
	handleContextMenu(event: MouseEvent): void {
		const target = event.target as HTMLElement;

		// Check if right-clicked on status dot
		if (target.classList.contains('task-status-dot')) {
			event.preventDefault();
			event.stopPropagation();
			this.showStatusMenu(target, event);
			return;
		}

		// Check if right-clicked on priority badge
		if (target.classList.contains('task-priority-badge')) {
			event.preventDefault();
			event.stopPropagation();
			this.showPriorityMenu(target, event);
			return;
		}
	}

	/**
	 * Show status selection menu
	 */
	showStatusMenu(element: HTMLElement, event: MouseEvent): void {
		const taskPath = element.dataset.taskPath;
		const currentStatus = element.dataset.status;

		if (!taskPath) return;

		const menu = new Menu();

		const statusOptions: StatusOption[] = [
			{ value: 'none', label: '⚪ None', icon: '⚪' },
			{ value: 'open', label: '🔵 Open', icon: '🔵' },
			{ value: 'in-progress', label: '🟡 In Progress', icon: '🟡' },
			{ value: 'done', label: '✅ Done', icon: '✅' },
			{ value: 'dropped', label: '🔴 Dropped', icon: '🔴' }
		];

		statusOptions.forEach(option => {
			menu.addItem((item) => {
				item
					.setTitle(option.label + (currentStatus === option.value ? ' ✓' : ''))
					.onClick(async () => {
						await this.setStatus(element, taskPath, option.value);
					});
			});
		});

		menu.showAtMouseEvent(event);
	}

	/**
	 * Show priority selection menu
	 */
	showPriorityMenu(element: HTMLElement, event: MouseEvent): void {
		const taskPath = element.dataset.taskPath;
		const currentPriority = element.dataset.priority;

		if (!taskPath) return;

		const menu = new Menu();

		const priorityOptions: PriorityOption[] = [
			{ value: 'anytime', label: '• Anytime', icon: '•' },
			{ value: 'today', label: '⭐ Today', icon: '⭐' },
			{ value: 'someday', label: '💭 Someday', icon: '💭' }
		];

		priorityOptions.forEach(option => {
			menu.addItem((item) => {
				item
					.setTitle(option.label + (currentPriority === option.value ? ' ✓' : ''))
					.onClick(async () => {
						await this.setPriority(element, taskPath, option.value);
					});
			});
		});

		menu.showAtMouseEvent(event);
	}

	/**
	 * Set task status to specific value
	 */
	async setStatus(element: HTMLElement, taskPath: string, status: string): Promise<void> {
		try {
			await this.updateTaskField(taskPath, 'status', status);

			// Update task row data attribute
			const taskRow = element.closest('.minimal-task-row');
			if (taskRow) {
				taskRow.setAttribute('data-status', status);
			}

			// Update status dot
			element.dataset.status = status;

			// Update title strikethrough via CSS class
			const title = taskRow?.querySelector('.minimal-task-title');
			if (title) {
				if (status === 'done' || status === 'dropped') {
					title.classList.add('is-completed');
				} else {
					title.classList.remove('is-completed');
				}
			}

			// Show notification
			const statusLabels: { [key: string]: string } = {
				'none': '⚪ None',
				'open': '🔵 Open',
				'in-progress': '🟡 In Progress',
				'done': '✅ Done',
				'dropped': '🔴 Dropped'
			};
			new Notice(statusLabels[status] || status);

		} catch (error) {
			console.error('Error setting status:', error);
			new Notice('Error updating task status');
		}
	}

	/**
	 * Set task priority to specific value
	 */
	async setPriority(element: HTMLElement, taskPath: string, priority: string): Promise<void> {
		try {
			await this.updateTaskField(taskPath, 'priority', priority);

			// Update priority badge immediately (visual feedback)
			element.dataset.priority = priority;
			element.textContent = this.getPriorityIcon(priority);

			// Show notification
			const priorityLabels: { [key: string]: string } = {
				'anytime': '• Anytime',
				'today': '⭐ Today',
				'someday': '💭 Someday'
			};
			new Notice(priorityLabels[priority] || priority);

		} catch (error) {
			console.error('Error setting priority:', error);
			new Notice('Error updating task priority');
		}
	}

	/**
	 * Cycle task status: none → open → in-progress → done → dropped → none
	 */
	async cycleStatus(element: HTMLElement): Promise<void> {
		const taskPath = element.dataset.taskPath;
		const currentStatus = element.dataset.status;

		if (!taskPath) return;

		const statuses = ['none', 'open', 'in-progress', 'done', 'dropped'];
		const currentIndex = statuses.indexOf(currentStatus || 'none');
		const nextStatus = statuses[(currentIndex + 1) % statuses.length];

		try {
			await this.updateTaskField(taskPath, 'status', nextStatus);

			// Update task row data attribute
			const taskRow = element.closest('.minimal-task-row');
			if (taskRow) {
				taskRow.setAttribute('data-status', nextStatus);
			}

			// Update status dot
			element.dataset.status = nextStatus;

			// Update title strikethrough via CSS class
			const title = taskRow?.querySelector('.minimal-task-title');
			if (title) {
				if (nextStatus === 'done' || nextStatus === 'dropped') {
					title.classList.add('is-completed');
				} else {
					title.classList.remove('is-completed');
				}
			}

			// Show notification
			const statusLabels: { [key: string]: string } = {
				'none': '⚪ None',
				'open': '🔵 Open',
				'in-progress': '🟡 In Progress',
				'done': '✅ Done',
				'dropped': '🔴 Dropped'
			};
			new Notice(statusLabels[nextStatus] || nextStatus);

		} catch (error) {
			console.error('Error cycling status:', error);
			new Notice('Error updating task status');
		}
	}

	/**
	 * Cycle task priority: anytime → today → someday → anytime
	 */
	async cyclePriority(element: HTMLElement): Promise<void> {
		const taskPath = element.dataset.taskPath;
		const currentPriority = element.dataset.priority;

		if (!taskPath) return;

		const priorities = ['anytime', 'today', 'someday'];
		const currentIndex = priorities.indexOf(currentPriority || 'anytime');
		const nextPriority = priorities[(currentIndex + 1) % priorities.length];

		try {
			await this.updateTaskField(taskPath, 'priority', nextPriority);

			// Update priority badge immediately (visual feedback)
			element.dataset.priority = nextPriority;
			element.textContent = this.getPriorityIcon(nextPriority);

			// Show notification
			const priorityLabels: { [key: string]: string } = {
				'anytime': '• Anytime',
				'today': '⭐ Today',
				'someday': '💭 Someday'
			};
			new Notice(priorityLabels[nextPriority] || nextPriority);

		} catch (error) {
			console.error('Error cycling priority:', error);
			new Notice('Error updating task priority');
		}
	}

	/**
	 * Update a field in task frontmatter
	 */
	async updateTaskField(taskPath: string, field: string, value: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(taskPath);
		if (!file || !(file instanceof TFile)) {
			throw new Error(`Task file not found: ${taskPath}`);
		}

		// Read file content
		const content = await this.app.vault.read(file);

		// Parse frontmatter
		const { frontmatter, body } = this.parseFrontmatter(content);

		// Check if this is a recurring task being marked as done
		const isRecurring = frontmatter.rrule && String(frontmatter.rrule).trim().length > 0;
		const isMarkingDone = field === 'status' && value === 'done';

		if (isRecurring && isMarkingDone) {
			// Create next instance before marking current as done
			await this.createNextRecurringInstance(frontmatter, body);
		}

		// Update field
		frontmatter[field] = value;

		// If status changed to done, add completedDate
		if (field === 'status' && value === 'done' && !frontmatter.completedDate) {
			frontmatter.completedDate = new Date().toISOString().split('T')[0];
		}

		// If status changed from done to something else, remove completedDate
		if (field === 'status' && value !== 'done' && frontmatter.completedDate) {
			delete frontmatter.completedDate;
		}

		// Rebuild content
		const newContent = this.rebuildContent(frontmatter, body);

		// Write back
		await this.app.vault.modify(file, newContent);
	}

	/**
	 * Create next instance of a recurring task
	 */
	async createNextRecurringInstance(frontmatter: Frontmatter, body: string): Promise<void> {
		try {
			new Notice('🔁 Creating next instance...', 2000);

			const rrule = String(frontmatter.rrule).replace(/^["']|["']$/g, ''); // Remove quotes
			const today = new Date().toISOString().split('T')[0];

			// Calculate next scheduled date using recurrence_calculator
			const nextDate = this.calculateNextOccurrence(rrule, today);

			// Create new task filename (timestamp-based)
			const now = new Date();
			const timestamp = now.toISOString()
				.replace(/[:.]/g, '-')
				.replace('T', '-')
				.split('-')
				.slice(0, 6)
				.join('');
			const formatted = timestamp.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1$2$3-$4$5$6');
			const newFilename = `${formatted}.md`;
			const newPath = `gtd/actions/${newFilename}`;

			// Build new frontmatter (clone all fields except status/dates)
			const nowISO = now.toISOString();
			const newFrontmatter: Frontmatter = {
				status: 'open',
				priority: frontmatter.priority || 'anytime',
				dateCreated: nowISO,
				dateModified: nowISO,
				tags: frontmatter.tags || '[]',
				type: 'action',
				title: frontmatter.title || '',
				contexts: frontmatter.contexts || [],
				area: frontmatter.area || '""',
				scheduled: nextDate,
				rrule: `"${rrule}"`,
			};

			// Clone optional fields
			if (frontmatter.projects) newFrontmatter.projects = frontmatter.projects;
			if (frontmatter.due) newFrontmatter.due = frontmatter.due;
			if (frontmatter.recurrence_start) newFrontmatter.recurrence_start = frontmatter.recurrence_start;
			if (frontmatter.store) newFrontmatter.store = frontmatter.store;
			if (frontmatter['discuss-with']) newFrontmatter['discuss-with'] = frontmatter['discuss-with'];
			if (frontmatter['discuss-during']) newFrontmatter['discuss-during'] = frontmatter['discuss-during'];

			// Build new content
			const newContent = this.rebuildContent(newFrontmatter, body);

			// Create new task file
			await this.app.vault.create(newPath, newContent);

			new Notice(`✅ Completed! Next: ${nextDate}`, 3000);

		} catch (error) {
			console.error('Failed to create recurring task instance:', error);
			new Notice('⚠️ Failed to create next instance: ' + (error as Error).message, 5000);
		}
	}

	/**
	 * Calculate next occurrence using RRULE
	 * This is a simplified implementation - uses the same logic as recurrence_calculator.js
	 */
	private calculateNextOccurrence(rrule: string, afterDate: string): string {
		const parts = this.parseRRule(rrule);
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
					const allowedDays = parts.BYDAY.split(',').map(this.dayCodeToNumber);
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
				const allowedDays = byDay.split(',').map(this.dayCodeToNumber);

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

	private dayCodeToNumber(code: string): number {
		const days: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
		return days[code] || 0;
	}

	/**
	 * Parse frontmatter and body from file content
	 */
	parseFrontmatter(content: string): ParsedContent {
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
	rebuildContent(frontmatter: Frontmatter, body: string): string {
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

	/**
	 * Trigger Dataview refresh
	 */
	refreshDataview(): void {
		setTimeout(() => {
			// Try multiple methods to refresh Dataview
			try {
				(this.app as any).commands.executeCommandById('dataview:dataview-rebuild-current-view');
			} catch (e) {
				// Fallback: trigger metadata cache update
				this.app.metadataCache.trigger('changed');
			}
		}, 100);
	}

	// ========================================
	// Convert inline task to action file
	// ========================================

	/**
	 * Convert an inline markdown task to an action file
	 * @param taskText - The task text (without the "- [ ] " prefix)
	 * @param lineFrom - Start position of the line
	 * @param lineTo - End position of the line
	 * @param view - The CodeMirror EditorView
	 */
	async convertToAction(taskText: string, lineFrom: number, lineTo: number, view: EditorView): Promise<void> {
		try {
			// 1. Detect context from current note
			const context = await this.detectNoteContext();

			// 2. Generate filename
			const timestamp = this.generateTimestamp();
			const filename = `${timestamp}.md`;
			const path = `gtd/actions/${filename}`;

			// 3. Build frontmatter
			const frontmatter = this.buildConvertFrontmatter(taskText, context);

			// 4. Create action file
			const content = this.buildActionContent(frontmatter);
			await this.app.vault.create(path, content);

			// 5. Replace line with wikilink
			const wikilink = `- [ ] [[${timestamp}|${taskText}]]`;
			view.dispatch({
				changes: { from: lineFrom, to: lineTo, insert: wikilink }
			});

			new Notice(`Created action: ${taskText}`);

		} catch (error) {
			console.error('Error converting task:', error);
			new Notice('Error converting task: ' + (error as Error).message);
		}
	}

	/**
	 * Detect context (project/area) from the current note
	 */
	async detectNoteContext(): Promise<{ projects?: string[], area?: string }> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return {};

		const content = await this.app.vault.read(activeFile);
		const { frontmatter } = this.parseFrontmatter(content);

		// Check if we're in a project note
		if (activeFile.path.startsWith('gtd/projects/') && !activeFile.path.includes('archive')) {
			return { projects: [`[[${activeFile.basename}]]`] };
		}

		// Check if we're in an event with a project
		if (frontmatter.type === 'event' && frontmatter.project) {
			// Event project field is a string like "[[Project Name]]"
			return { projects: [frontmatter.project] };
		}

		// Check for area field
		if (frontmatter.area) {
			return { area: frontmatter.area };
		}

		return {};
	}

	/**
	 * Generate timestamp for action filename (YYYYMMDD-HHMMSS)
	 */
	generateTimestamp(): string {
		const now = new Date();
		const pad = (n: number) => n.toString().padStart(2, '0');
		return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	}

	/**
	 * Build frontmatter for a converted action
	 */
	buildConvertFrontmatter(title: string, context: { projects?: string[], area?: string }): Frontmatter {
		const now = new Date().toISOString();
		const fm: Frontmatter = {
			type: 'action',
			title: title,
			status: 'open',
			priority: 'anytime',
			dateCreated: now,
			dateModified: now,
			tags: [],
			contexts: [],
		};

		// Filter out any falsy values from projects array (handle both strings and objects)
		const validProjects = (context.projects || []).filter(p => {
			if (!p) return false;
			const str = typeof p === 'string' ? p : String(p);
			return str.trim().length > 0;
		});

		// Add project or area (mutually exclusive - projects take precedence)
		if (validProjects.length > 0) {
			fm.projects = validProjects;
			fm.area = '""';
		} else if (context.area && context.area.trim() && context.area !== '""') {
			fm.projects = [];
			fm.area = context.area;
		} else {
			fm.projects = [];
			fm.area = '""';
		}

		return fm;
	}

	/**
	 * Build action file content with frontmatter and ribbon
	 */
	buildActionContent(frontmatter: Frontmatter): string {
		const body = '```dataviewjs\nawait dv.view("apps/dataview/unified-ribbon");\n```\n';
		return this.rebuildContent(frontmatter, body);
	}

	onunload(): void {
		console.log('Unloading Minimal Tasks plugin');
		delete window.MinimalTasks;
	}
}

// Settings Tab
class MinimalTasksSettingTab extends PluginSettingTab {
	plugin: MinimalTasksPlugin;

	constructor(app: App, plugin: MinimalTasksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Minimal Tasks Settings' });

		// Field Names Section
		containerEl.createEl('h3', { text: 'Frontmatter Field Names' });
		containerEl.createEl('p', {
			text: 'Customize which frontmatter fields are used for task metadata.',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Status field')
			.setDesc('Frontmatter field for task status')
			.addText(text => text
				.setPlaceholder('status')
				.setValue(this.plugin.settings.statusField)
				.onChange(async (value) => {
					this.plugin.settings.statusField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Priority field')
			.setDesc('Frontmatter field for task priority')
			.addText(text => text
				.setPlaceholder('priority')
				.setValue(this.plugin.settings.priorityField)
				.onChange(async (value) => {
					this.plugin.settings.priorityField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Projects field')
			.setDesc('Frontmatter field for project links (array)')
			.addText(text => text
				.setPlaceholder('projects')
				.setValue(this.plugin.settings.projectField)
				.onChange(async (value) => {
					this.plugin.settings.projectField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Contexts field')
			.setDesc('Frontmatter field for contexts (array)')
			.addText(text => text
				.setPlaceholder('contexts')
				.setValue(this.plugin.settings.contextsField)
				.onChange(async (value) => {
					this.plugin.settings.contextsField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Due date field')
			.setDesc('Frontmatter field for due date')
			.addText(text => text
				.setPlaceholder('due')
				.setValue(this.plugin.settings.dueField)
				.onChange(async (value) => {
					this.plugin.settings.dueField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Scheduled field')
			.setDesc('Frontmatter field for scheduled date')
			.addText(text => text
				.setPlaceholder('scheduled')
				.setValue(this.plugin.settings.scheduledField)
				.onChange(async (value) => {
					this.plugin.settings.scheduledField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Discuss-with field')
			.setDesc('Frontmatter field for people to discuss with (array)')
			.addText(text => text
				.setPlaceholder('discuss-with')
				.setValue(this.plugin.settings.discussWithField)
				.onChange(async (value) => {
					this.plugin.settings.discussWithField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Discuss-during field')
			.setDesc('Frontmatter field for meetings to discuss during (array)')
			.addText(text => text
				.setPlaceholder('discuss-during')
				.setValue(this.plugin.settings.discussDuringField)
				.onChange(async (value) => {
					this.plugin.settings.discussDuringField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Store field')
			.setDesc('Frontmatter field for store/location (errands)')
			.addText(text => text
				.setPlaceholder('store')
				.setValue(this.plugin.settings.storeField)
				.onChange(async (value) => {
					this.plugin.settings.storeField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Area field')
			.setDesc('Frontmatter field for area/category')
			.addText(text => text
				.setPlaceholder('area')
				.setValue(this.plugin.settings.areaField)
				.onChange(async (value) => {
					this.plugin.settings.areaField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Title field')
			.setDesc('Frontmatter field for task title')
			.addText(text => text
				.setPlaceholder('title')
				.setValue(this.plugin.settings.titleField)
				.onChange(async (value) => {
					this.plugin.settings.titleField = value;
					await this.plugin.saveSettings();
				}));

		// Display Options Section
		containerEl.createEl('h3', { text: 'Display Options' });

		new Setting(containerEl)
			.setName('Show projects')
			.setDesc('Display project links below tasks')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showProjects)
				.onChange(async (value) => {
					this.plugin.settings.showProjects = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show project due dates')
			.setDesc('Show due date warnings for projects')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showProjectDueDates)
				.onChange(async (value) => {
					this.plugin.settings.showProjectDueDates = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show note icon')
			.setDesc('Show ☰ icon for tasks with content')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showNoteIcon)
				.onChange(async (value) => {
					this.plugin.settings.showNoteIcon = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enable convert icon')
			.setDesc('Show a convert icon at the end of markdown task lines in edit mode. Click to convert to an action file. Requires restart to take effect.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableConvertIcon)
				.onChange(async (value) => {
					this.plugin.settings.enableConvertIcon = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Note content ignore pattern')
			.setDesc('Regex pattern to ignore when detecting note content. Useful for stripping boilerplate code blocks like ribbons. Leave empty to disable.')
			.addTextArea(text => text
				.setPlaceholder('^\\s*```dataviewjs\\s*\\n\\s*await dv\\.view\\("(?:apps\\/dataview\\/)?unified-ribbon"\\);?\\s*\\n\\s*```\\s*')
				.setValue(this.plugin.settings.noteContentIgnorePattern)
				.onChange(async (value) => {
					this.plugin.settings.noteContentIgnorePattern = value;
					await this.plugin.saveSettings();
				}));
	}
}
