import { App, Plugin, PluginSettingTab, Setting, Menu, Notice, TFile, TAbstractFile } from 'obsidian';

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

	// Display options
	showProjects: boolean;
	showProjectDueDates: boolean;
	showNoteIcon: boolean;
	showContextPills: boolean;

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

	// Display options
	showProjects: true,
	showProjectDueDates: true,
	showNoteIcon: true,
	showContextPills: false,  // Usually hidden in context views

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
		// Generate link
		const title = task[this.settings.titleField];
		const taskLink = title
			? dv.fileLink(task.file.path, false, title)
			: dv.fileLink(task.file.path);

		// Enrich project metadata with due dates
		let projectsWithMeta: ProjectMeta[] | undefined = undefined;
		const projects = task[this.settings.projectField];
		if (projects && projects.length > 0) {
			projectsWithMeta = projects.map((project: any): ProjectMeta => {
				// Convert Link object to string if needed
				const projectLink = typeof project === 'string' ? project : String(project);

				// Extract the path from wikilink [[path|display]] or [[path]]
				const match = projectLink.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
				if (!match) return { link: projectLink };

				const projectPath = match[1];
				const projectPage = dv.page(projectPath);

				if (!projectPage) return { link: projectLink };

				// Add due date metadata if exists
				if (projectPage[this.settings.dueField]) {
					const dueDate = dv.date(projectPage[this.settings.dueField]);
					const today = dv.date('today');
					const formattedDate = dueDate.toFormat('MMM dd');

					return {
						link: projectLink,
						due: projectPage[this.settings.dueField],
						dueFormatted: formattedDate,
						overdue: dueDate < today
					};
				}

				return { link: projectLink };
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

			// Remove the action button ribbon (dataviewjs block)
			const ribbonRegex = /^\s*```dataviewjs\s*\n\s*await dv\.view\("apps\/dataview\/action-button-ribbon"\);?\s*\n\s*```\s*/;
			remainingContent = remainingContent.replace(ribbonRegex, '').trim();

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
		const contexts = (task as any)[this.settings.contextsField] || [];
		const discussWith = (task as any)[this.settings.discussWithField];
		const discussDuring = (task as any)[this.settings.discussDuringField];
		const store = (task as any)[this.settings.storeField];
		const projects = (task as any)[this.settings.projectField] || [];

		let html = '';

		// 1. Priority badge
		html += this.renderPriorityBadge(priority, path);

		// 2. Status dot
		html += this.renderStatusDot(status, path);

		// 3. Task link (with strikethrough for done/dropped)
		const taskLinkHtml = task.link || 'Untitled';
		const shouldStrikethrough = status === 'done' || status === 'dropped';
		html += ' ' + (shouldStrikethrough
			? `<span style="text-decoration: line-through; opacity: 0.6;">${taskLinkHtml}</span>`
			: taskLinkHtml);

		// 4. Note icon (if task has content)
		if (hasNotes && this.settings.showNoteIcon) {
			html += ' <span style="font-size: 0.85em;">☰</span>';
		}

		// 5. Date badges (due and scheduled)
		html += this.renderDateBadges(task);

		// 6. Context pills (if enabled and not excluded)
		if (showContexts && contexts.length > 0 && !excludePills.includes('contexts')) {
			html += this.renderContextPills(contexts);
		}

		// 7. Discuss-with pills
		if (discussWith && !excludePills.includes('person')) {
			html += this.renderDiscussWithPills(discussWith);
		}

		// 8. Discuss-during pills
		if (discussDuring && !excludePills.includes('meeting')) {
			html += this.renderDiscussDuringPills(discussDuring);
		}

		// 9. Store pill (for errands)
		if (store && !excludePills.includes('store')) {
			html += this.renderStorePill(store);
		}

		// 10. Projects (on line below, with enriched due date data)
		if (this.settings.showProjects && showProjects && projects.length > 0) {
			html += this.renderProjects(task.projectsWithMeta || projects);
		}

		return html;
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
		const pills = (Array.isArray(contexts) ? contexts : [contexts]).map(ctx =>
			`<span style="background: var(--background-modifier-border); color: var(--text-muted); padding: 2px 6px; border-radius: 10px; font-size: 0.75em; margin-left: 4px;">@${ctx}</span>`
		).join('');
		return ` ${pills}`;
	}

	renderDiscussWithPills(discussWith: string | string[]): string {
		const people = Array.isArray(discussWith) ? discussWith : [discussWith];
		let html = '';
		people.forEach(person => {
			html += ` <span style="background: var(--background-modifier-border); color: var(--text-muted); padding: 2px 6px; border-radius: 10px; font-size: 0.75em; margin-left: 4px;">👤${person}</span>`;
		});
		return html;
	}

	renderDiscussDuringPills(discussDuring: string | string[]): string {
		const events = Array.isArray(discussDuring) ? discussDuring : [discussDuring];
		let html = '';
		events.forEach(event => {
			html += ` <span style="background: var(--background-modifier-border); color: var(--text-muted); padding: 2px 6px; border-radius: 10px; font-size: 0.75em; margin-left: 4px;">📅${event}</span>`;
		});
		return html;
	}

	renderStorePill(store: string): string {
		return ` <span style="background: var(--background-modifier-border); color: var(--text-muted); padding: 2px 6px; border-radius: 10px; font-size: 0.75em; margin-left: 4px;">🏪${store}</span>`;
	}

	renderDateBadges(task: EnrichedTask): string {
		let html = '';
		const due = (task as any)[this.settings.dueField];
		const scheduled = (task as any)[this.settings.scheduledField];

		// Parse dates if they exist
		if (due || scheduled) {
			const today = new Date();
			today.setHours(0, 0, 0, 0);

			// Scheduled date badge (show first)
			if (scheduled) {
				const scheduledDate = new Date(scheduled);
				scheduledDate.setHours(0, 0, 0, 0);
				const formattedScheduled = this.formatDate(scheduledDate);
				html += ` <span style="background: var(--background-modifier-border); color: var(--text-muted); padding: 2px 6px; border-radius: 10px; font-size: 0.75em; margin-left: 4px;">🗓️ ${formattedScheduled}</span>`;
			}

			// Due date badge (show second)
			if (due) {
				const dueDate = new Date(due);
				dueDate.setHours(0, 0, 0, 0);
				const isOverdue = dueDate < today;
				const formattedDue = this.formatDate(dueDate);

				if (isOverdue) {
					html += ` <span style="background: var(--background-modifier-error); color: var(--text-on-accent); padding: 2px 6px; border-radius: 10px; font-size: 0.75em; margin-left: 4px;">⚠️ ${formattedDue}</span>`;
				} else {
					html += ` <span style="background: var(--background-modifier-border); color: var(--text-muted); padding: 2px 6px; border-radius: 10px; font-size: 0.75em; margin-left: 4px;">📅 ${formattedDue}</span>`;
				}
			}
		}

		return html;
	}

	formatDate(date: Date): string {
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		return `${months[date.getMonth()]} ${date.getDate()}`;
	}

	renderProjects(projects: ProjectMeta[] | any[]): string {
		if (!projects || projects.length === 0) return '';

		let html = '';
		const projectLines = projects.map(project => {
			// If enriched metadata exists (projectsWithMeta), use it
			if ((project as ProjectMeta).link) {
				// Enriched project with metadata
				const p = project as ProjectMeta;
				let line = p.link;
				if (this.settings.showProjectDueDates && p.due) {
					const dueDate = p.dueFormatted || p.due;
					if (p.overdue) {
						// Overdue: use error background like task badges
						line += ` <span style="background: var(--background-modifier-error); color: var(--text-on-accent); padding: 2px 6px; border-radius: 10px; font-size: 0.75em; margin-left: 4px;">⚠️ ${dueDate}</span>`;
					} else {
						// Normal due date: use same style as task due badges
						line += ` <span style="background: var(--background-modifier-border); color: var(--text-muted); padding: 2px 6px; border-radius: 10px; font-size: 0.75em; margin-left: 4px;">📅 ${dueDate}</span>`;
					}
				}
				return line;
			} else {
				// Plain project string (fallback)
				return typeof project === 'string' ? project : String(project);
			}
		});

		// Add each project on its own line with proper styling
		projectLines.forEach(line => {
			html += `<br><span style="color: var(--text-muted); font-size: 0.85em; padding-left: 38px;">${line}</span>`;
		});

		return html;
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

			// Update status dot color immediately (visual feedback)
			element.dataset.status = status;

			// Update task link strikethrough
			// Find the task link that follows this status dot (traverse siblings)
			let taskLink: Element | null = null;
			let sibling = element.nextElementSibling;
			while (sibling) {
				if (sibling.classList.contains('internal-link')) {
					taskLink = sibling;
					break;
				}
				// Also check if the link is wrapped in a span
				const linkInside = sibling.querySelector('.internal-link');
				if (linkInside) {
					taskLink = linkInside;
					break;
				}
				sibling = sibling.nextElementSibling;
			}
			if (taskLink) {
				const shouldStrikethrough = status === 'done' || status === 'dropped';
				if (shouldStrikethrough) {
					// Wrap in span with strikethrough if not already wrapped
					if (!taskLink.parentElement?.classList.contains('task-strikethrough')) {
						const wrapper = document.createElement('span');
						wrapper.classList.add('task-strikethrough');
						wrapper.style.textDecoration = 'line-through';
						wrapper.style.opacity = '0.6';
						taskLink.parentElement?.insertBefore(wrapper, taskLink);
						wrapper.appendChild(taskLink);
					}
				} else {
					// Remove wrapper if exists
					const wrapper = taskLink.parentElement;
					if (wrapper?.classList.contains('task-strikethrough')) {
						wrapper.parentElement?.insertBefore(taskLink, wrapper);
						wrapper.remove();
					}
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

			// Update status dot color immediately (visual feedback)
			element.dataset.status = nextStatus;

			// Update task link strikethrough
			// Find the task link that follows this status dot (traverse siblings)
			let taskLink: Element | null = null;
			let sibling = element.nextElementSibling;
			while (sibling) {
				if (sibling.classList.contains('internal-link')) {
					taskLink = sibling;
					break;
				}
				// Also check if the link is wrapped in a span
				const linkInside = sibling.querySelector('.internal-link');
				if (linkInside) {
					taskLink = linkInside;
					break;
				}
				sibling = sibling.nextElementSibling;
			}
			if (taskLink) {
				const shouldStrikethrough = nextStatus === 'done' || nextStatus === 'dropped';
				if (shouldStrikethrough) {
					// Wrap in span with strikethrough if not already wrapped
					if (!taskLink.parentElement?.classList.contains('task-strikethrough')) {
						const wrapper = document.createElement('span');
						wrapper.classList.add('task-strikethrough');
						wrapper.style.textDecoration = 'line-through';
						wrapper.style.opacity = '0.6';
						taskLink.parentElement?.insertBefore(wrapper, taskLink);
						wrapper.appendChild(taskLink);
					}
				} else {
					// Remove wrapper if exists
					const wrapper = taskLink.parentElement;
					if (wrapper?.classList.contains('task-strikethrough')) {
						wrapper.parentElement?.insertBefore(taskLink, wrapper);
						wrapper.remove();
					}
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
				lines.push(`${key}:`);
				value.forEach(item => {
					lines.push(`  - ${item}`);
				});
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
	}
}
