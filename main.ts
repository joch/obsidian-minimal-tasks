import { App, Plugin, Menu, Notice, TFile, TAbstractFile, MarkdownPostProcessorContext } from 'obsidian';
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { Range } from '@codemirror/state';

// Import types and settings from modules
import {
	MinimalTasksSettings,
	DataviewAPI,
	TaskFile,
	EnrichedTask,
	ProjectMeta,
	ProcessedTask,
	RenderOptions,
	Frontmatter,
	ParsedContent,
	StatusOption,
	PriorityOption
} from './src/types';
import { DEFAULT_SETTINGS, MinimalTasksSettingTab } from './src/settings';
import {
	escapeHtml,
	generateTimestamp,
	ordinalSuffix,
	ordinalNumber,
	formatDate,
	formatDTSTART,
	formatDateForInput,
	extractDisplayName,
	extractLinkPath,
	stripEventPrefix
} from './src/utils';
import { parseFrontmatter, rebuildContent } from './src/frontmatter';
import { parseRRule, formatRRuleReadable, calculateNextOccurrence, dayCodeToNumber } from './src/recurrence';
import {
	getPriorityIcon,
	renderStatusDot,
	renderPriorityBadge,
	renderContextPills,
	renderDiscussWithPills,
	renderDiscussDuringPills,
	renderStorePill,
	renderRecurrencePill,
	renderProjectPills
} from './src/rendering';
import { EditTaskModal } from './src/modals';

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

// Widget for rendering action links as full task rows
class ActionLinkWidget extends WidgetType {
	constructor(
		private plugin: MinimalTasksPlugin,
		private actionPath: string,
		private displayTitle: string
	) {
		super();
	}

	toDOM(): HTMLElement {
		// Get frontmatter from metadata cache (synchronous)
		const file = this.plugin.app.vault.getAbstractFileByPath(this.actionPath + '.md');
		const cache = file ? this.plugin.app.metadataCache.getFileCache(file as TFile) : null;
		const fm = cache?.frontmatter || {};
		const hasNotes = cache?.sections?.some(s => s.type === 'paragraph' || s.type === 'list' || s.type === 'heading');

		// Use shared rendering method
		return this.plugin.createInlineTaskElement(fm, this.actionPath + '.md', this.displayTitle, hasNotes || false);
	}

	eq(other: ActionLinkWidget): boolean {
		return this.actionPath === other.actionPath;
	}
}

// ViewPlugin factory for action link rendering
function createActionLinkPlugin(plugin: MinimalTasksPlugin) {
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
				const decorations: Range<Decoration>[] = [];
				// Match action links: - [ ] [[gtd/actions/...|...]] or - [x] [[...|...]]
				// Also match short form: - [ ] [[20251203-...|...]]
				const actionLinkRegex = /^(\s*)- \[[ x]\] \[\[(gtd\/actions\/)?(\d{8}-\d{6})\|([^\]]+)\]\]\s*$/;

				for (const { from, to } of view.visibleRanges) {
					for (let pos = from; pos <= to;) {
						const line = view.state.doc.lineAt(pos);
						const match = line.text.match(actionLinkRegex);
						if (match) {
							const indent = match[1];
							const actionPath = `gtd/actions/${match[3]}`;
							const displayTitle = match[4];

							const widget = Decoration.replace({
								widget: new ActionLinkWidget(plugin, actionPath, displayTitle)
							});
							// Replace from after indent to end of line
							const replaceFrom = line.from + indent.length;
							decorations.push(widget.range(replaceFrom, line.to));
						}
						pos = line.to + 1;
					}
				}
				return Decoration.set(decorations, true);
			}
		},
		{ decorations: v => v.decorations }
	);
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
				// Pattern to detect action links (already converted tasks)
				const actionLinkPattern = /\[\[(gtd\/actions\/)?\d{8}-\d{6}\|/;

				for (const { from, to } of view.visibleRanges) {
					for (let pos = from; pos <= to;) {
						const line = view.state.doc.lineAt(pos);
						const match = line.text.match(taskRegex);
						// Only add convert icon if it's a plain task (not an action link)
						if (match && match[2] && !actionLinkPattern.test(line.text)) {
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

		// Register CodeMirror extension for rendering action links as task rows
		this.registerEditorExtension(createActionLinkPlugin(this));

		// Register MarkdownPostProcessor for reading view
		this.registerMarkdownPostProcessor((element, context) => {
			this.processActionLinks(element, context);
		});

		// Add ribbon icon for creating new actions
		this.addRibbonIcon('plus-circle', 'New Action', async () => {
			await this.createNewAction();
		});

		// Register commands
		this.addCommand({
			id: 'new-action',
			name: 'Create new action',
			callback: async () => {
				await this.createNewAction();
			}
		});

		this.addCommand({
			id: 'new-action-from-context',
			name: 'Create new action from current note',
			callback: async () => {
				await this.createNewActionFromContext();
			}
		});

		this.addCommand({
			id: 'edit-action',
			name: 'Edit current action',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.path.startsWith('gtd/actions/')) {
					if (!checking) {
						new EditTaskModal(this.app, this, activeFile.path).open();
					}
					return true;
				}
				return false;
			}
		});
	}

	/**
	 * Create a new action and open the edit modal
	 */
	async createNewAction(prefill?: { project?: string; context?: string; area?: string; body?: string }): Promise<void> {
		try {
			// Generate filename
			const timestamp = generateTimestamp();
			const filename = `${timestamp}.md`;
			const path = `gtd/actions/${filename}`;

			// Build default frontmatter
			const now = new Date().toISOString();
			const frontmatter: Frontmatter = {
				type: 'action',
				title: '',
				status: 'open',
				priority: 'anytime',
				dateCreated: now,
				dateModified: now,
				tags: [],
				contexts: prefill?.context ? [prefill.context] : [],
				projects: prefill?.project ? [`"[[${prefill.project}]]"`] : [],
				area: prefill?.area ? `"[[gtd/areas/${prefill.area}|${prefill.area}]]"` : '""'
			};

			// Open the edit modal in create mode (file will be created on save)
			new EditTaskModal(this.app, this, path, frontmatter, prefill?.body).open();

		} catch (error) {
			console.error('Error creating action:', error);
			new Notice('Error creating action: ' + (error as Error).message);
		}
	}

	/**
	 * Create a new action with context pre-filled from current note
	 */
	async createNewActionFromContext(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			// No active file, just create a blank action
			await this.createNewAction();
			return;
		}

		const cache = this.app.metadataCache.getFileCache(activeFile);
		const type = cache?.frontmatter?.type;

		let prefill: { project?: string; context?: string; area?: string; body?: string } = {};

		if (type === 'project') {
			// Pre-fill with this project
			prefill.project = activeFile.path;
		} else if (type === 'event' || type === 'meeting') {
			// Pre-fill with project from event if it has one
			const projectLink = cache?.frontmatter?.project;
			if (projectLink) {
				const match = String(projectLink).match(/\[\[([^\]|]+)/);
				if (match) {
					const projectBasename = match[1].split('/').pop()?.replace(/\.md$/, '');
					const projectFile = this.app.vault.getMarkdownFiles()
						.find(f => f.basename === projectBasename && f.path.startsWith('gtd/projects/'));
					if (projectFile) {
						prefill.project = projectFile.path;
					}
				}
			}
		} else if (activeFile.path.startsWith('gtd/areas/')) {
			// Pre-fill with this area
			prefill.area = activeFile.basename;
		}

		// For checklists, include the body content in the new action
		if (type === 'checklist-template' || type === 'checklist') {
			const content = await this.app.vault.read(activeFile);
			const parsed = parseFrontmatter(content);
			// Remove any existing dataviewjs blocks from the body
			const cleanBody = parsed.body
				.replace(/```dataviewjs\s*\n[\s\S]*?\n```\s*/g, '')
				.replace(/---\s*$/g, '')  // Remove trailing separators
				.trim();
			if (cleanBody) {
				// Add link to source and the content
				const sourceLink = `From: [[${activeFile.path.replace(/\.md$/, '')}]]`;
				prefill.body = `${sourceLink}\n\n${cleanBody}`;
			}
		}

		await this.createNewAction(prefill);
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

		// Sort tasks (uses effective due date: earliest of task due and project dues)
		const sortedProcessed = this.sortTasks(processedTasks);

		// Render each task
		const taskHtmlArray = sortedProcessed.map(processedTask => {
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
	 * Get effective due date for a task (earliest of task due and project dues)
	 * @param processedTask - Processed task with enriched data
	 * @returns Earliest due date string or null
	 */
	private getEffectiveDueDate(processedTask: ProcessedTask): string | null {
		const taskDue = processedTask.task[this.settings.dueField];
		const projectDues = processedTask.enrichedTask.projectsWithMeta
			?.map((p: ProjectMeta) => p.due)
			.filter(Boolean) || [];

		const allDates = [taskDue, ...projectDues].filter(Boolean);
		if (allDates.length === 0) return null;

		// Sort dates lexicographically (works for ISO date strings)
		return allDates.sort()[0];
	}

	/**
	 * Sort tasks by standard criteria
	 * @param processedTasks - Array of processed tasks to sort
	 * @returns Sorted array of processed tasks
	 */
	sortTasks(processedTasks: ProcessedTask[]): ProcessedTask[] {
		return processedTasks.sort((a: ProcessedTask, b: ProcessedTask) => {
			const statusField = this.settings.statusField;
			const priorityField = this.settings.priorityField;

			// 1. In-progress tasks first
			const aInProgress = a.task[statusField] === "in-progress";
			const bInProgress = b.task[statusField] === "in-progress";
			if (aInProgress && !bInProgress) return -1;
			if (!aInProgress && bInProgress) return 1;

			// 2. Priority: today tasks next
			const aTodayPriority = a.task[priorityField] === "today";
			const bTodayPriority = b.task[priorityField] === "today";
			if (aTodayPriority && !bTodayPriority) return -1;
			if (!aTodayPriority && bTodayPriority) return 1;

			// 3. Tasks with effective due dates (task due or project due)
			const aDue = this.getEffectiveDueDate(a);
			const bDue = this.getEffectiveDueDate(b);
			if (aDue && !bDue) return -1;
			if (!aDue && bDue) return 1;
			if (aDue && bDue) {
				if (aDue < bDue) return -1;
				if (aDue > bDue) return 1;
			}

			// 4. Finally, oldest first
			return a.task.file.ctime - b.task.file.ctime;
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
		const content = this.createContent(task, hasNotes, isCompleted, showContexts, excludePills, path);
		const mainLine = this.createMainLine(controls, content);
		const projectsSection = this.createProjectsSection(task, showProjects);

		return `<div class="minimal-task-row" data-task-path="${path}" data-status="${status}" data-priority="${priority}">${mainLine}${projectsSection}</div>`;
	}

	private createControls(priority: string, status: string, path: string): string {
		return `<div class="minimal-task-controls">${renderPriorityBadge(priority, path)}${renderStatusDot(status, path)}</div>`;
	}

	private createContent(task: EnrichedTask, hasNotes: boolean, isCompleted: boolean, showContexts: boolean, excludePills: string[], path: string): string {
		const title = this.createTitle(task, isCompleted);
		const editIcon = `<span class="minimal-task-edit-icon" data-task-path="${path}" title="Edit task">⋯</span>`;
		const noteIcon = hasNotes && this.settings.showNoteIcon
			? '<span class="minimal-task-note-icon">›</span>'
			: '';
		const metadata = this.createMetadata(task, showContexts, excludePills);

		// Group title + icons together to prevent wrapping between them
		const titleGroup = `<span class="minimal-task-title-group">${title}${noteIcon}${editIcon}</span>`;

		return `<div class="minimal-task-content">${titleGroup}${metadata}</div>`;
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
			badges.push(renderRecurrencePill(rrule));
		}

		// Context pills
		const contexts = (task as any)[this.settings.contextsField] || [];
		if (showContexts && contexts.length > 0 && !excludePills.includes('contexts')) {
			badges.push(renderContextPills(contexts));
		}

		// Discuss-with pills
		const discussWith = (task as any)[this.settings.discussWithField];
		if (discussWith && !excludePills.includes('person')) {
			badges.push(renderDiscussWithPills(discussWith));
		}

		// Discuss-during pills
		const discussDuring = (task as any)[this.settings.discussDuringField];
		if (discussDuring && !excludePills.includes('meeting')) {
			badges.push(renderDiscussDuringPills(discussDuring));
		}

		// Store pill
		const store = (task as any)[this.settings.storeField];
		if (store && !excludePills.includes('store')) {
			badges.push(renderStorePill(store));
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

	/**
	 * Render inline task HTML for action links (reuses DataviewJS helpers)
	 * Used by both widget and postprocessor
	 */
	renderInlineTaskHTML(fm: Record<string, any>, path: string, displayTitle: string, hasNotes: boolean): string {
		const status = fm[this.settings.statusField] || 'open';
		const priority = fm[this.settings.priorityField] || 'anytime';
		const title = fm[this.settings.titleField] || displayTitle;
		const isCompleted = status === 'done' || status === 'dropped';
		const hrefPath = path.replace('.md', '');

		// Build parts using existing helpers
		const priorityBadge = renderPriorityBadge(priority, path);
		const statusDot = renderStatusDot(status, path);

		const completedClass = isCompleted ? ' is-completed' : '';
		const titleHtml = `<a class="internal-link${completedClass}" data-href="${hrefPath}" href="${hrefPath}">${escapeHtml(title)}</a>`;

		const noteIcon = hasNotes && this.settings.showNoteIcon
			? '<span class="minimal-task-note-icon">›</span>'
			: '';

		const editIcon = `<span class="minimal-task-edit-icon" data-task-path="${path}" title="Edit task">⋯</span>`;

		// Build metadata using existing helpers
		const badges: string[] = [];

		const scheduled = fm[this.settings.scheduledField];
		if (scheduled) {
			badges.push(`<span class="minimal-badge minimal-badge-date">🗓️ ${scheduled}</span>`);
		}

		const due = fm[this.settings.dueField];
		if (due) {
			const isOverdue = new Date(due) < new Date(new Date().toDateString());
			const overdueClass = isOverdue ? ' is-overdue' : '';
			badges.push(`<span class="minimal-badge minimal-badge-date${overdueClass}">📅 ${due}</span>`);
		}

		const rrule = fm[this.settings.rruleField];
		if (rrule) {
			badges.push(renderRecurrencePill(rrule));
		}

		const contexts = fm[this.settings.contextsField] || [];
		if (contexts.length > 0) {
			badges.push(renderContextPills(contexts));
		}

		const projects = fm[this.settings.projectField] || [];
		if (projects.length > 0) {
			badges.push(renderProjectPills(projects));
		}

		const metadata = badges.length > 0
			? ` <span class="minimal-task-metadata">${badges.join('')}</span>`
			: '';

		// Group title + icons together to prevent wrapping between them
		const titleGroup = `<span class="minimal-task-title-group">${titleHtml}${noteIcon}${editIcon}</span>`;

		return `${priorityBadge}${statusDot} ${titleGroup}${metadata}`;
	}

	/**
	 * Create an inline task element for action links (used by widget and postprocessor)
	 * Parses HTML from renderInlineTaskHTML using DOMParser for safety
	 */
	createInlineTaskElement(fm: Record<string, any>, path: string, displayTitle: string, hasNotes: boolean): HTMLElement {
		const html = this.renderInlineTaskHTML(fm, path, displayTitle, hasNotes);
		const parser = new DOMParser();
		const doc = parser.parseFromString(`<span class="minimal-task-inline">${html}</span>`, 'text/html');
		return doc.body.firstChild as HTMLElement;
	}

	renderDateBadges(task: EnrichedTask): string {
		const badges: string[] = [];
		const due = (task as any)[this.settings.dueField];
		const scheduled = (task as any)[this.settings.scheduledField];

		if (scheduled) {
			const scheduledDate = new Date(scheduled);
			scheduledDate.setHours(0, 0, 0, 0);
			const formattedScheduled = formatDate(scheduledDate);
			badges.push(`<span class="minimal-badge minimal-badge-date">🗓️ ${formattedScheduled}</span>`);
		}

		if (due) {
			const dueDate = new Date(due);
			dueDate.setHours(0, 0, 0, 0);
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const isOverdue = dueDate < today;
			const formattedDue = formatDate(dueDate);
			const icon = isOverdue ? '⚠️' : '📅';
			const badgeClass = isOverdue ? ' is-overdue' : '';
			badges.push(`<span class="minimal-badge minimal-badge-date${badgeClass}">${icon} ${formattedDue}</span>`);
		}

		return badges.join('');
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

		// Check if clicked on edit icon
		if (target.classList.contains('minimal-task-edit-icon')) {
			event.preventDefault();
			event.stopPropagation();
			const taskPath = target.dataset.taskPath;
			if (taskPath) {
				new EditTaskModal(this.app, this, taskPath).open();
			}
			return;
		}

		// Check if clicked on convert icon (reading view)
		if (target.classList.contains('minimal-tasks-convert-icon')) {
			event.preventDefault();
			event.stopPropagation();
			const taskText = target.dataset.taskText;
			const sourcePath = target.dataset.sourcePath;
			if (taskText && sourcePath) {
				await this.convertToActionFromReading(taskText, sourcePath);
			}
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
			element.textContent = getPriorityIcon(priority);

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
			element.textContent = getPriorityIcon(nextPriority);

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
		const { frontmatter, body } = parseFrontmatter(content);

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
		const newContent = rebuildContent(frontmatter, body);

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
			const nextDate = calculateNextOccurrence(rrule, today);

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
				priority: 'anytime',  // Always reset - scheduled date controls visibility
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

			// Calculate new due date with same offset from scheduled
			if (frontmatter.due && frontmatter.scheduled) {
				const originalScheduled = new Date(frontmatter.scheduled);
				const originalDue = new Date(frontmatter.due);
				const offsetMs = originalDue.getTime() - originalScheduled.getTime();
				const newDue = new Date(new Date(nextDate).getTime() + offsetMs);
				newFrontmatter.due = newDue.toISOString().split('T')[0];
			} else if (frontmatter.due) {
				// If no scheduled date, just copy due as-is
				newFrontmatter.due = frontmatter.due;
			}

			if (frontmatter.recurrence_start) newFrontmatter.recurrence_start = frontmatter.recurrence_start;
			if (frontmatter.store) newFrontmatter.store = frontmatter.store;
			if (frontmatter['discuss-with']) newFrontmatter['discuss-with'] = frontmatter['discuss-with'];
			if (frontmatter['discuss-during']) newFrontmatter['discuss-during'] = frontmatter['discuss-during'];

			// Build new content
			const newContent = rebuildContent(newFrontmatter, body);

			// Create new task file
			await this.app.vault.create(newPath, newContent);

			new Notice(`✅ Completed! Next: ${nextDate}`, 3000);

		} catch (error) {
			console.error('Failed to create recurring task instance:', error);
			new Notice('⚠️ Failed to create next instance: ' + (error as Error).message, 5000);
		}
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
	 * Process action links in reading view (MarkdownPostProcessor)
	 * Replaces [[timestamp|title]] links inside task list items with rich task display
	 * Also adds convert buttons to plain markdown tasks
	 */
	processActionLinks(element: HTMLElement, context: MarkdownPostProcessorContext): void {
		// Find all task list items
		const taskItems = element.querySelectorAll('li.task-list-item');

		for (const li of Array.from(taskItems)) {
			// Find action links inside
			const links = li.querySelectorAll('a.internal-link');
			let hasActionLink = false;

			for (const link of Array.from(links)) {
				const href = link.getAttribute('data-href') || '';
				// Match action links: gtd/actions/YYYYMMDD-HHMMSS or just YYYYMMDD-HHMMSS
				const match = href.match(/^(gtd\/actions\/)?(\d{8}-\d{6})$/);
				if (!match) continue;

				hasActionLink = true;
				const actionPath = `gtd/actions/${match[2]}.md`;
				const displayTitle = link.textContent || match[2];

				// Get action metadata from cache
				const actionFile = this.app.vault.getAbstractFileByPath(actionPath);
				if (!(actionFile instanceof TFile)) continue;

				const cache = this.app.metadataCache.getFileCache(actionFile);
				const fm = cache?.frontmatter || {};
				const hasNotes = cache?.sections?.some(s => s.type === 'paragraph' || s.type === 'list' || s.type === 'heading');

				// Use shared rendering method
				const container = this.createInlineTaskElement(fm, actionPath, displayTitle, hasNotes || false);

				// Replace the original link with our rich display
				link.replaceWith(container);

				// Hide the original checkbox (we have status dot)
				const checkbox = li.querySelector('input[type="checkbox"]');
				if (checkbox) {
					(checkbox as HTMLElement).style.display = 'none';
				}
			}

			// If no action link found, add convert button for plain tasks
			if (!hasActionLink) {
				// Get the text content of the task (excluding checkbox)
				const checkbox = li.querySelector('input[type="checkbox"]');
				if (!checkbox) continue;

				// Get task text - everything after the checkbox
				const taskText = this.getTaskTextFromListItem(li);
				if (!taskText || taskText.trim() === '') continue;

				// Add convert button
				const convertIcon = document.createElement('span');
				convertIcon.className = 'minimal-tasks-convert-icon';
				convertIcon.textContent = '➕';
				convertIcon.setAttribute('data-task-text', taskText);
				convertIcon.setAttribute('data-source-path', context.sourcePath);

				// Append at end of list item
				li.appendChild(convertIcon);
			}
		}
	}

	/**
	 * Extract task text from a list item element
	 */
	private getTaskTextFromListItem(li: Element): string {
		// Clone the element to avoid modifying the original
		const clone = li.cloneNode(true) as HTMLElement;

		// Remove the checkbox
		const checkbox = clone.querySelector('input[type="checkbox"]');
		if (checkbox) checkbox.remove();

		// Remove any existing convert icons
		const convertIcon = clone.querySelector('.minimal-tasks-convert-icon');
		if (convertIcon) convertIcon.remove();

		// Get text content
		return clone.textContent?.trim() || '';
	}

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
			const timestamp = generateTimestamp();
			const filename = `${timestamp}.md`;
			const path = `gtd/actions/${filename}`;

			// 3. Build frontmatter
			const frontmatter = this.buildConvertFrontmatter(taskText, context);

			// 4. Create action file (with source link)
			const activeFile = this.app.workspace.getActiveFile();
			const sourcePath = activeFile?.path;
			const content = this.buildActionContent(frontmatter, sourcePath);
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
	 * Convert an inline markdown task to an action file (from reading view)
	 * @param taskText - The task text (without the "- [ ] " prefix)
	 * @param sourcePath - The path of the file containing the task
	 */
	async convertToActionFromReading(taskText: string, sourcePath: string): Promise<void> {
		try {
			const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
			if (!(sourceFile instanceof TFile)) {
				new Notice('Source file not found');
				return;
			}

			// 1. Detect context from source note
			const content = await this.app.vault.read(sourceFile);
			const { frontmatter } = parseFrontmatter(content);

			let context: { projects?: string[], area?: string } = {};

			// Check if source is a project note
			if (sourcePath.startsWith('gtd/projects/') && !sourcePath.includes('archive')) {
				const basename = sourcePath.split('/').pop()?.replace('.md', '') || '';
				context = { projects: [`[[${basename}]]`] };
			}
			// Check if source is an event with a project
			else if (frontmatter.type === 'event' && frontmatter.project) {
				context = { projects: [frontmatter.project] };
			}
			// Check for area field
			else if (frontmatter.area) {
				context = { area: frontmatter.area };
			}

			// 2. Generate filename
			const timestamp = generateTimestamp();
			const filename = `${timestamp}.md`;
			const path = `gtd/actions/${filename}`;

			// 3. Build frontmatter
			const actionFrontmatter = this.buildConvertFrontmatter(taskText, context);

			// 4. Create action file (with source link)
			const actionContent = this.buildActionContent(actionFrontmatter, sourcePath);
			await this.app.vault.create(path, actionContent);

			// 5. Replace task in source file
			// Match both checked and unchecked tasks
			const escapedTaskText = taskText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const taskPattern = new RegExp(`^(\\s*)- \\[[ x]\\] ${escapedTaskText}$`, 'm');
			const newContent = content.replace(taskPattern, `$1- [ ] [[${timestamp}|${taskText}]]`);

			if (newContent !== content) {
				await this.app.vault.modify(sourceFile, newContent);
				new Notice(`Created action: ${taskText}`);
			} else {
				new Notice('Could not find task in source file');
			}

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
		const { frontmatter } = parseFrontmatter(content);

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
	buildActionContent(frontmatter: Frontmatter, sourcePath?: string): string {
		let body = '```dataviewjs\nawait dv.view("apps/dataview/unified-ribbon");\n```\n';
		if (sourcePath) {
			const basename = sourcePath.replace('.md', '');
			body += `\nCreated from [[${basename}]]\n`;
		}
		return rebuildContent(frontmatter, body);
	}

	onunload(): void {
		console.log('Unloading Minimal Tasks plugin');
		delete window.MinimalTasks;
	}
}
