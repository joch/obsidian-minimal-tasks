import { App, Plugin, PluginSettingTab, Setting, Menu, Notice, TFile, TAbstractFile, Modal, MarkdownPostProcessorContext } from 'obsidian';
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

// ========================================
// Edit Task Modal - Things 3-inspired design
// ========================================

class EditTaskModal extends Modal {
	private taskPath: string;
	private plugin: MinimalTasksPlugin;
	private frontmatter: Frontmatter = {};
	private body: string = '';
	private isCreateMode: boolean = false;
	private didSave: boolean = false;

	constructor(app: App, plugin: MinimalTasksPlugin, taskPath: string, initialFrontmatter?: Frontmatter, initialBody?: string) {
		super(app);
		this.plugin = plugin;
		this.taskPath = taskPath;

		// If initial frontmatter is provided, we're in create mode (file doesn't exist yet)
		if (initialFrontmatter) {
			this.isCreateMode = true;
			this.frontmatter = initialFrontmatter;
			// Default body with unified-ribbon, plus any additional content
			this.body = '```dataviewjs\nawait dv.view("apps/dataview/unified-ribbon");\n```\n';
			if (initialBody) {
				this.body += '\n' + initialBody;
			}
		}
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.addClass('edit-task-modal');

		if (this.isCreateMode) {
			// Create mode - use provided frontmatter, don't load from file
			this.buildForm();
			return;
		}

		// Edit mode - load current frontmatter from file
		const file = this.app.vault.getAbstractFileByPath(this.taskPath);
		if (!file || !(file instanceof TFile)) {
			contentEl.createEl('p', { text: 'Error: Task file not found' });
			return;
		}

		const content = await this.app.vault.read(file);
		const parsed = this.plugin.parseFrontmatter(content);
		this.frontmatter = parsed.frontmatter;
		this.body = parsed.body;

		// Build the form
		this.buildForm();
	}

	private buildForm(): void {
		const { contentEl } = this;
		contentEl.empty();

		// Forward declarations for elements referenced across sections
		let discussSection: HTMLElement;
		let storeSection: HTMLElement;
		let scheduledInput: HTMLInputElement;

		// Title input (large, at top)
		const titleContainer = contentEl.createDiv({ cls: 'edit-task-title-container' });
		const titleInput = titleContainer.createEl('input', {
			cls: 'edit-task-title-input',
			attr: {
				type: 'text',
				placeholder: 'Task title...',
				value: String(this.frontmatter.title || '').replace(/^["']|["']$/g, '')
			}
		});
		titleInput.addEventListener('change', () => {
			this.frontmatter.title = titleInput.value;
		});

		// Focus title input so user can start typing immediately
		setTimeout(() => titleInput.focus(), 0);

		// Contexts section (pill toggles)
		const contextsSection = contentEl.createDiv({ cls: 'edit-task-section' });
		contextsSection.createDiv({ cls: 'edit-task-section-label', text: 'Contexts' });
		const contextsContainer = contextsSection.createDiv({ cls: 'edit-task-contexts' });

		const allContexts = ['focus', 'quick', 'relax', 'home', 'office', 'brf', 'school', 'errands', 'agenda', 'waiting'];
		const currentContexts = this.getArrayField('contexts');

		const updateConditionalSections = () => {
			const activeContexts = this.getActiveContexts(contextsContainer);
			if (discussSection) {
				// Show if @agenda context OR if discuss-with/discuss-during has a value
				const hasDiscussValue = this.frontmatter['discuss-with']?.length > 0 ||
				                        this.frontmatter['discuss-during']?.length > 0;
				discussSection.style.display = (activeContexts.includes('agenda') || hasDiscussValue) ? '' : 'none';
			}
			if (storeSection) {
				// Show if @errands context OR if store has a value
				const hasStoreValue = this.frontmatter.store &&
				                      String(this.frontmatter.store).replace(/^["']|["']$/g, '').trim() !== '';
				storeSection.style.display = (activeContexts.includes('errands') || hasStoreValue) ? '' : 'none';
			}
		};

		allContexts.forEach(ctx => {
			const pill = contextsContainer.createSpan({
				cls: 'context-pill' + (currentContexts.includes(ctx) ? ' active' : ''),
				text: '@' + ctx
			});
			pill.addEventListener('click', () => {
				pill.toggleClass('active', !pill.hasClass('active'));
				this.updateContexts(contextsContainer);
				updateConditionalSections();
			});
		});

		// Project & Area section (same row)
		const projectAreaSection = contentEl.createDiv({ cls: 'edit-task-section' });
		const projectAreaRow = projectAreaSection.createDiv({ cls: 'edit-task-row-inline' });

		// Project dropdown
		const projectGroup = projectAreaRow.createDiv({ cls: 'edit-task-inline-group' });
		projectGroup.createSpan({ cls: 'edit-task-label', text: '📂 Project' });
		const projectSelect = projectGroup.createEl('select', { cls: 'edit-task-select-project' });
		projectSelect.createEl('option', { value: '', text: '(none)' });

		// Area emoji mapping and order
		const areaEmoji: Record<string, string> = {
			"Personal": "👨‍💻",
			"Family": "🧑‍🎨",
			"Social": "🕺",
			"Home": "🏠",
			"Opper": "🏢",
			"Solvändan": "☀️",
			"Garage": "🚗"
		};
		const areaOrder = ["Personal", "Family", "Social", "Home", "Opper", "Solvändan", "Garage", ""];

		// Get projects from vault with area info
		const projectFiles = this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith('gtd/projects/') && !f.path.includes('archive'))
			.map(f => {
				const cache = this.app.metadataCache.getFileCache(f);
				let areaField = cache?.frontmatter?.area;
				let area = "";

				if (areaField && typeof areaField === 'string') {
					areaField = areaField.replace(/^["']|["']$/g, '');
					if (areaField.includes('|')) {
						const parts = areaField.split('|');
						if (parts.length >= 2) {
							area = parts[1].replace(/\]\]$/, '').trim();
						}
					}
				}

				return { file: f, area };
			})
			.sort((a, b) => a.file.basename.localeCompare(b.file.basename));

		// Group projects by area
		const projectsByArea = new Map<string, typeof projectFiles>();
		projectFiles.forEach(pf => {
			const area = pf.area || "";
			if (!projectsByArea.has(area)) {
				projectsByArea.set(area, []);
			}
			projectsByArea.get(area)!.push(pf);
		});

		// Add projects grouped by area
		const currentProject = this.getProjectBasename();
		areaOrder.forEach(area => {
			const areaProjects = projectsByArea.get(area);
			if (!areaProjects || areaProjects.length === 0) return;

			const emoji = areaEmoji[area] || "📦";
			const groupLabel = area ? `${emoji} ${area}` : "📦 No Area";
			const optgroup = projectSelect.createEl('optgroup', { attr: { label: groupLabel } });

			areaProjects.forEach(pf => {
				const opt = optgroup.createEl('option', {
					value: pf.file.path,
					text: pf.file.basename
				});
				if (pf.file.basename === currentProject) opt.selected = true;
			});
		});

		// Area dropdown
		const areaGroup = projectAreaRow.createDiv({ cls: 'edit-task-inline-group' });
		areaGroup.createSpan({ cls: 'edit-task-label', text: '🗂️ Area' });
		const areaSelect = areaGroup.createEl('select', { cls: 'edit-task-select-small' });

		const areas = ['', 'Personal', 'Family', 'Social', 'Home', 'Opper', 'Solvändan', 'Garage'];
		const currentArea = this.getAreaName();
		areas.forEach(a => {
			const emoji = a ? areaEmoji[a] || '📦' : '';
			const text = a ? `${emoji} ${a}` : '(none)';
			const opt = areaSelect.createEl('option', { value: a, text });
			if (a === currentArea) opt.selected = true;
		});
		areaSelect.addEventListener('change', () => {
			if (areaSelect.value) {
				this.frontmatter.area = `"[[gtd/areas/${areaSelect.value}|${areaSelect.value}]]"`;
			} else {
				this.frontmatter.area = '""';
			}
		});

		projectSelect.addEventListener('change', () => {
			if (projectSelect.value) {
				const selectedProject = projectFiles.find(pf => pf.file.path === projectSelect.value);
				if (selectedProject) {
					this.frontmatter.projects = [`"[[${selectedProject.file.path}|${selectedProject.file.basename}]]"`];
					// Clear area when project is selected (projects have their own area)
					areaSelect.value = '';
					this.frontmatter.area = '""';
				}
			} else {
				this.frontmatter.projects = [];
			}
		});

		// Discuss section (same row for with & during) - only shown when @agenda context or has value
		discussSection = contentEl.createDiv({ cls: 'edit-task-section' });
		const discussRow = discussSection.createDiv({ cls: 'edit-task-row-inline' });

		// Discuss-with dropdown
		const discussWithGroup = discussRow.createDiv({ cls: 'edit-task-inline-group' });
		discussWithGroup.createSpan({ cls: 'edit-task-label', text: '👤 With' });
		const discussWithSelect = discussWithGroup.createEl('select', { cls: 'edit-task-select-small' });
		discussWithSelect.createEl('option', { value: '', text: '(none)' });

		const personFiles = this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith('notes/person/'))
			.sort((a, b) => a.basename.localeCompare(b.basename));

		const currentDiscussWith = this.getDiscussWithBasename();
		personFiles.forEach(pf => {
			const opt = discussWithSelect.createEl('option', {
				value: pf.path,
				text: pf.basename
			});
			if (pf.basename === currentDiscussWith) opt.selected = true;
		});
		discussWithSelect.addEventListener('change', () => {
			if (discussWithSelect.value) {
				const selectedFile = personFiles.find(f => f.path === discussWithSelect.value);
				if (selectedFile) {
					this.frontmatter['discuss-with'] = [`"[[${selectedFile.path}|${selectedFile.basename}]]"`];
				}
			} else {
				delete this.frontmatter['discuss-with'];
			}
		});

		// Discuss-during dropdown
		const discussDuringGroup = discussRow.createDiv({ cls: 'edit-task-inline-group' });
		discussDuringGroup.createSpan({ cls: 'edit-task-label', text: '📅 During' });
		const discussDuringSelect = discussDuringGroup.createEl('select', { cls: 'edit-task-select-small' });
		discussDuringSelect.createEl('option', { value: '', text: '(none)' });

		// Get events from vault (recent events first)
		const eventFiles = this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith('events/'))
			.sort((a, b) => b.basename.localeCompare(a.basename)) // Most recent first
			.slice(0, 50); // Limit to 50 most recent

		const currentDiscussDuring = this.getDiscussDuringBasename();
		eventFiles.forEach(ef => {
			// Strip date/time prefix for display: "2025-11-16 1400 Meeting Name" -> "Meeting Name"
			const displayName = ef.basename.replace(/^\d{4}-\d{2}-\d{2} \d{4} /, '');
			const opt = discussDuringSelect.createEl('option', {
				value: ef.path,
				text: displayName
			});
			if (ef.basename === currentDiscussDuring || displayName === currentDiscussDuring) opt.selected = true;
		});
		discussDuringSelect.addEventListener('change', () => {
			if (discussDuringSelect.value) {
				const selectedFile = eventFiles.find(f => f.path === discussDuringSelect.value);
				if (selectedFile) {
					const displayName = selectedFile.basename.replace(/^\d{4}-\d{2}-\d{2} \d{4} /, '');
					this.frontmatter['discuss-during'] = [`"[[${selectedFile.path}|${displayName}]]"`];
				}
			} else {
				delete this.frontmatter['discuss-during'];
			}
		});

		// Store section (input with datalist for suggestions) - only shown when @errands context or has value
		storeSection = contentEl.createDiv({ cls: 'edit-task-section' });
		const storeRow = storeSection.createDiv({ cls: 'edit-task-row-inline' });
		const storeGroup = storeRow.createDiv({ cls: 'edit-task-inline-group' });
		storeGroup.createSpan({ cls: 'edit-task-label', text: '🏪 Store' });

		const storeInput = storeGroup.createEl('input', {
			cls: 'edit-task-input-small',
			attr: {
				type: 'text',
				placeholder: 'Type or select...',
				list: 'store-suggestions',
				value: String(this.frontmatter.store || '').replace(/^["']|["']$/g, '')
			}
		});

		// Create datalist with existing stores
		const storeDatalist = storeRow.createEl('datalist', { attr: { id: 'store-suggestions' } });

		// Get unique stores from existing tasks
		const existingStores = new Set<string>();
		this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith('gtd/actions/'))
			.forEach(f => {
				const cache = this.app.metadataCache.getFileCache(f);
				const store = cache?.frontmatter?.store;
				if (store) {
					const storeStr = String(store).replace(/^["']|["']$/g, '');
					if (storeStr) existingStores.add(storeStr);
				}
			});

		// Sort stores alphabetically and add as options
		Array.from(existingStores).sort().forEach(store => {
			storeDatalist.createEl('option', { value: store });
		});

		storeInput.addEventListener('change', () => {
			if (storeInput.value) {
				this.frontmatter.store = storeInput.value;
			} else {
				delete this.frontmatter.store;
			}
		});

		// Set initial visibility of conditional sections
		updateConditionalSections();

		// Dates section (same row)
		const datesSection = contentEl.createDiv({ cls: 'edit-task-section' });
		const datesRow = datesSection.createDiv({ cls: 'edit-task-row-inline' });

		// Scheduled date
		const scheduledGroup = datesRow.createDiv({ cls: 'edit-task-inline-group' });
		scheduledGroup.createSpan({ cls: 'edit-task-label', text: '🗓️ Scheduled' });
		scheduledInput = scheduledGroup.createEl('input', {
			cls: 'edit-task-date-input-small',
			attr: {
				type: 'date',
				value: this.formatDateForInput(this.frontmatter.scheduled)
			}
		});
		scheduledInput.addEventListener('change', () => {
			this.frontmatter.scheduled = scheduledInput.value || undefined;
			if (!scheduledInput.value) delete this.frontmatter.scheduled;
		});

		// Due date
		const dueGroup = datesRow.createDiv({ cls: 'edit-task-inline-group' });
		dueGroup.createSpan({ cls: 'edit-task-label', text: '📅 Due' });
		const dueInput = dueGroup.createEl('input', {
			cls: 'edit-task-date-input-small',
			attr: {
				type: 'date',
				value: this.formatDateForInput(this.frontmatter.due)
			}
		});
		dueInput.addEventListener('change', () => {
			this.frontmatter.due = dueInput.value || undefined;
			if (!dueInput.value) delete this.frontmatter.due;
		});

		// Recurrence section
		const recurrenceSection = contentEl.createDiv({ cls: 'edit-task-section' });
		const recurrenceRow = recurrenceSection.createDiv({ cls: 'edit-task-row-inline' });

		const recurrenceGroup = recurrenceRow.createDiv({ cls: 'edit-task-inline-group' });
		recurrenceGroup.createSpan({ cls: 'edit-task-label', text: '🔁 Repeat' });

		// Frequency dropdown
		const freqSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		const frequencies = [
			{ label: '(none)', value: '' },
			{ label: 'Daily', value: 'DAILY' },
			{ label: 'Weekdays', value: 'WEEKDAYS' },
			{ label: 'Weekly on', value: 'WEEKLY' },
			{ label: 'Biweekly on', value: 'BIWEEKLY' },
			{ label: 'Monthly on the', value: 'MONTHLY' },
			{ label: 'Quarterly on the', value: 'QUARTERLY' },
			{ label: 'Yearly on', value: 'YEARLY' }
		];

		// Day of week dropdown (for weekly/biweekly)
		const dayOfWeekSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		const dayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
		dayNames.forEach((day, i) => {
			dayOfWeekSelect.createEl('option', { value: dayCodes[i], text: day });
		});
		dayOfWeekSelect.style.display = 'none';

		// Day of month dropdown (for monthly/quarterly)
		const dayOfMonthSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		for (let i = 1; i <= 31; i++) {
			const suffix = i === 1 || i === 21 || i === 31 ? 'st' : i === 2 || i === 22 ? 'nd' : i === 3 || i === 23 ? 'rd' : 'th';
			dayOfMonthSelect.createEl('option', { value: String(i), text: `${i}${suffix}` });
		}
		dayOfMonthSelect.style.display = 'none';

		// Start date for recurrence (when recurrence begins)
		const startGroup = recurrenceRow.createDiv({ cls: 'edit-task-inline-group' });
		startGroup.createSpan({ cls: 'edit-task-label', text: 'from' });
		const recurrenceStartInput = startGroup.createEl('input', {
			cls: 'edit-task-date-input-small',
			attr: { type: 'date' }
		});
		startGroup.style.display = 'none';

		// Month + day for yearly
		const monthSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
		monthNames.forEach((month, i) => {
			monthSelect.createEl('option', { value: String(i + 1), text: month });
		});
		monthSelect.style.display = 'none';

		const yearDaySelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		for (let i = 1; i <= 31; i++) {
			yearDaySelect.createEl('option', { value: String(i), text: String(i) });
		}
		yearDaySelect.style.display = 'none';

		// Parse current rrule
		const currentRRule = String(this.frontmatter.rrule || '').replace(/^["']|["']$/g, '');
		let currentFreq = '';
		let currentDayCode = dayCodes[new Date().getDay()];
		let currentMonthDay = new Date().getDate();
		let currentMonth = new Date().getMonth() + 1;
		let currentStartDate = this.frontmatter.recurrence_start
			? String(this.frontmatter.recurrence_start).replace(/^["']|["']$/g, '')
			: scheduledInput.value || new Date().toISOString().split('T')[0];

		if (currentRRule) {
			const parts = this.plugin.parseRRule(currentRRule);
			// Extract DTSTART if present
			if (parts.DTSTART) {
				const ds = parts.DTSTART;
				if (ds.length === 8) {
					currentStartDate = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`;
				}
			}
			if (parts.FREQ === 'DAILY' && parts.BYDAY === 'MO,TU,WE,TH,FR') {
				currentFreq = 'WEEKDAYS';
			} else if (parts.FREQ === 'DAILY') {
				currentFreq = 'DAILY';
			} else if (parts.FREQ === 'WEEKLY' && parts.INTERVAL === '2') {
				currentFreq = 'BIWEEKLY';
				if (parts.BYDAY) currentDayCode = parts.BYDAY;
			} else if (parts.FREQ === 'WEEKLY') {
				currentFreq = 'WEEKLY';
				if (parts.BYDAY) currentDayCode = parts.BYDAY;
			} else if (parts.FREQ === 'MONTHLY' && parts.INTERVAL === '3') {
				currentFreq = 'QUARTERLY';
				if (parts.BYMONTHDAY) currentMonthDay = parseInt(parts.BYMONTHDAY);
			} else if (parts.FREQ === 'MONTHLY') {
				currentFreq = 'MONTHLY';
				if (parts.BYMONTHDAY) currentMonthDay = parseInt(parts.BYMONTHDAY);
			} else if (parts.FREQ === 'YEARLY') {
				currentFreq = 'YEARLY';
				if (parts.BYMONTHDAY) currentMonthDay = parseInt(parts.BYMONTHDAY);
				if (parts.BYMONTH) currentMonth = parseInt(parts.BYMONTH);
			}
		}

		// Populate frequency dropdown
		frequencies.forEach(f => {
			const opt = freqSelect.createEl('option', { value: f.value, text: f.label });
			if (f.value === currentFreq) opt.selected = true;
		});

		// Set initial values for detail selects
		dayOfWeekSelect.value = currentDayCode;
		dayOfMonthSelect.value = String(currentMonthDay);
		monthSelect.value = String(currentMonth);
		yearDaySelect.value = String(currentMonthDay);
		recurrenceStartInput.value = currentStartDate;

		// Update visibility of detail selects
		const updateDetailVisibility = () => {
			const freq = freqSelect.value;
			dayOfWeekSelect.style.display = (freq === 'WEEKLY' || freq === 'BIWEEKLY') ? '' : 'none';
			dayOfMonthSelect.style.display = (freq === 'MONTHLY' || freq === 'QUARTERLY') ? '' : 'none';
			monthSelect.style.display = freq === 'YEARLY' ? '' : 'none';
			yearDaySelect.style.display = freq === 'YEARLY' ? '' : 'none';
			startGroup.style.display = freq ? '' : 'none';
		};
		updateDetailVisibility();

		// Generate rrule from current selections
		const generateRRule = (): string => {
			const startDate = recurrenceStartInput.value || scheduledInput.value || new Date().toISOString().split('T')[0];
			const dtstart = this.plugin.formatDTSTART(startDate);
			const freq = freqSelect.value;

			switch (freq) {
				case 'DAILY':
					return `DTSTART:${dtstart};FREQ=DAILY;INTERVAL=1`;
				case 'WEEKDAYS':
					return `DTSTART:${dtstart};FREQ=DAILY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR`;
				case 'WEEKLY':
					return `DTSTART:${dtstart};FREQ=WEEKLY;INTERVAL=1;BYDAY=${dayOfWeekSelect.value}`;
				case 'BIWEEKLY':
					return `DTSTART:${dtstart};FREQ=WEEKLY;INTERVAL=2;BYDAY=${dayOfWeekSelect.value}`;
				case 'MONTHLY':
					return `DTSTART:${dtstart};FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=${dayOfMonthSelect.value}`;
				case 'QUARTERLY':
					return `DTSTART:${dtstart};FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=${dayOfMonthSelect.value}`;
				case 'YEARLY':
					return `DTSTART:${dtstart};FREQ=YEARLY;INTERVAL=1;BYMONTH=${monthSelect.value};BYMONTHDAY=${yearDaySelect.value}`;
				default:
					return '';
			}
		};

		// Update frontmatter when any recurrence field changes
		const updateRecurrence = () => {
			const rrule = generateRRule();
			if (rrule) {
				const startDate = recurrenceStartInput.value || scheduledInput.value || new Date().toISOString().split('T')[0];
				this.frontmatter.rrule = rrule;
				this.frontmatter.recurrence_start = startDate;
			} else {
				delete this.frontmatter.rrule;
				delete this.frontmatter.recurrence_start;
			}
		};

		freqSelect.addEventListener('change', () => {
			updateDetailVisibility();
			updateRecurrence();
		});
		dayOfWeekSelect.addEventListener('change', updateRecurrence);
		dayOfMonthSelect.addEventListener('change', updateRecurrence);
		monthSelect.addEventListener('change', updateRecurrence);
		yearDaySelect.addEventListener('change', updateRecurrence);
		recurrenceStartInput.addEventListener('change', updateRecurrence);

		// Status & Priority section (icon toggles)
		const statusPrioritySection = contentEl.createDiv({ cls: 'edit-task-section' });
		const statusPriorityRow = statusPrioritySection.createDiv({ cls: 'edit-task-row-inline' });

		// Status icons
		const statusGroup = statusPriorityRow.createDiv({ cls: 'edit-task-inline-group' });
		statusGroup.createSpan({ cls: 'edit-task-label', text: 'Status' });
		const statusIcons = statusGroup.createDiv({ cls: 'edit-task-icon-group' });

		const statusOptions = [
			{ value: 'none', icon: '⚪' },
			{ value: 'open', icon: '🔵' },
			{ value: 'in-progress', icon: '🟡' },
			{ value: 'done', icon: '✅' },
			{ value: 'dropped', icon: '🔴' }
		];

		const currentStatus = this.frontmatter.status || 'none';
		statusOptions.forEach(opt => {
			const icon = statusIcons.createSpan({
				cls: 'edit-task-icon' + (currentStatus === opt.value ? ' active' : ''),
				text: opt.icon,
				attr: { title: opt.value }
			});
			icon.addEventListener('click', () => {
				statusIcons.querySelectorAll('.edit-task-icon').forEach(i => i.removeClass('active'));
				icon.addClass('active');
				this.frontmatter.status = opt.value;
			});
		});

		// Priority icons
		const priorityGroup = statusPriorityRow.createDiv({ cls: 'edit-task-inline-group' });
		priorityGroup.createSpan({ cls: 'edit-task-label', text: 'Priority' });
		const priorityIcons = priorityGroup.createDiv({ cls: 'edit-task-icon-group' });

		const priorityOptions = [
			{ value: 'anytime', icon: '•' },
			{ value: 'today', icon: '⭐' },
			{ value: 'someday', icon: '💭' }
		];

		const currentPriority = this.frontmatter.priority || 'anytime';
		priorityOptions.forEach(opt => {
			const icon = priorityIcons.createSpan({
				cls: 'edit-task-icon' + (currentPriority === opt.value ? ' active' : ''),
				text: opt.icon,
				attr: { title: opt.value }
			});
			icon.addEventListener('click', () => {
				priorityIcons.querySelectorAll('.edit-task-icon').forEach(i => i.removeClass('active'));
				icon.addClass('active');
				this.frontmatter.priority = opt.value;
			});
		});

		// Button row
		const buttonRow = contentEl.createDiv({ cls: 'edit-task-button-row' });

		// Delete button
		const deleteBtn = buttonRow.createEl('button', {
			cls: 'edit-task-delete',
			text: '🗑️'
		});
		deleteBtn.setAttribute('title', 'Delete task');
		deleteBtn.addEventListener('click', () => this.deleteTask());

		// AI suggestion button
		const aiBtn = buttonRow.createEl('button', {
			cls: 'edit-task-ai',
			text: '✨'
		});
		aiBtn.setAttribute('title', 'AI suggest fields');
		aiBtn.addEventListener('click', () => this.suggestFieldsWithAI(
			titleInput,
			statusIcons,
			priorityIcons,
			dueInput,
			scheduledInput,
			contextsContainer,
			projectSelect,
			areaSelect,
			discussWithSelect,
			discussDuringSelect,
			storeInput,
			updateConditionalSections
		));

		// Save button
		const saveBtn = buttonRow.createEl('button', {
			cls: 'edit-task-save',
			text: 'Save Changes'
		});
		saveBtn.addEventListener('click', () => this.saveChanges());

		// Keyboard shortcut: Cmd/Ctrl+Enter to save
		this.scope.register(['Mod'], 'Enter', (evt: KeyboardEvent) => {
			evt.preventDefault();
			this.saveChanges();
			return false;
		});
	}

	async deleteTask(): Promise<void> {
		if (this.isCreateMode) {
			// In create mode, just close without saving
			this.close();
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(this.taskPath);
		if (!file || !(file instanceof TFile)) {
			new Notice('Error: Task file not found');
			return;
		}

		// Get display title - strip quotes and use filename as fallback
		const title = String(this.frontmatter.title || '').replace(/^["']|["']$/g, '') || file.basename;

		// Confirm deletion
		if (confirm(`Delete "${title}"?`)) {
			await this.app.vault.delete(file);
			this.didSave = true; // Mark as needing refresh
			new Notice('Task deleted');
			this.close();
		}
	}

	async suggestFieldsWithAI(
		titleInput: HTMLInputElement,
		statusIcons: HTMLElement,
		priorityIcons: HTMLElement,
		dueInput: HTMLInputElement,
		scheduledInput: HTMLInputElement,
		contextsContainer: HTMLElement,
		projectSelect: HTMLSelectElement,
		areaSelect: HTMLSelectElement,
		discussWithSelect: HTMLSelectElement,
		discussDuringSelect: HTMLSelectElement,
		storeInput: HTMLInputElement,
		updateConditionalSections: () => void
	): Promise<void> {
		try {
			// Get the Opper AI plugin
			const opperPlugin = (this.app as any).plugins.plugins['opper-ai'];
			if (!opperPlugin) {
				new Notice('Opper AI plugin not found. Please install and enable it.');
				return;
			}
			if (!opperPlugin.api) {
				new Notice('Opper AI plugin API not initialized. Please reload Obsidian.');
				return;
			}

			new Notice('✨ Analyzing task...', 2000);

			// Get current date
			const today = new Date();
			const currentDate = today.toISOString().split('T')[0];

			// Get available projects
			const projectFiles = this.app.vault.getMarkdownFiles()
				.filter(f => f.path.startsWith('gtd/projects/') && !f.path.includes('archive'));
			const projects = projectFiles.map(f => {
				const cache = this.app.metadataCache.getFileCache(f);
				const state = cache?.frontmatter?.state;
				let areaField = cache?.frontmatter?.area;
				let area = "No Area";

				if (areaField && typeof areaField === 'string') {
					areaField = areaField.replace(/^["']|["']$/g, '');
					if (areaField.includes('|')) {
						const parts = areaField.split('|');
						if (parts.length >= 2) {
							area = parts[1].replace(/\]\]$/, '').trim();
						}
					}
				}

				return { name: f.basename, area, state };
			}).filter(p => p.state === 'active');

			// Get available people
			const personFiles = this.app.vault.getMarkdownFiles()
				.filter(f => f.path.startsWith('notes/person/'));
			const people = personFiles.map(f => f.basename);

			// Get available meetings (future events)
			const eventFiles = this.app.vault.getMarkdownFiles()
				.filter(f => f.path.startsWith('events/'));
			const meetings = eventFiles
				.filter(f => {
					const cache = this.app.metadataCache.getFileCache(f);
					const eventDate = cache?.frontmatter?.date;
					if (!eventDate) return true;
					return eventDate >= currentDate;
				})
				.map(f => f.basename);

			// Get available stores
			const existingStores = new Set<string>();
			this.app.vault.getMarkdownFiles()
				.filter(f => f.path.startsWith('gtd/actions/'))
				.forEach(f => {
					const cache = this.app.metadataCache.getFileCache(f);
					const store = cache?.frontmatter?.store;
					if (store) {
						const storeStr = String(store).replace(/^["']|["']$/g, '');
						if (storeStr) existingStores.add(storeStr);
					}
				});
			const stores = Array.from(existingStores);

			// Get task title and body
			const taskTitle = titleInput.value || '';
			const taskBody = this.body || '';

			// Call Opper AI
			const result = await opperPlugin.api.call(
				'detect-action-fields',
				{
					task_title: taskTitle,
					task_body: taskBody,
					current_date: currentDate,
					available_contexts: ['focus', 'quick', 'relax', 'home', 'office', 'brf', 'school', 'errands', 'agenda', 'waiting'],
					available_projects: projects,
					available_areas: ['Personal', 'Family', 'Social', 'Home', 'Opper', 'Solvändan', 'Garage'],
					available_people: people,
					available_meetings: meetings,
					available_stores: stores
				},
				{
					instructions: this.getAIInstructions(),
					outputSchema: this.getAIOutputSchema(),
					model: 'gcp/gemini-flash-latest'
				}
			);

			if (!result.json_payload) {
				new Notice('No suggestions from AI');
				return;
			}

			const detected = result.json_payload;
			const appliedFields: string[] = [];

			// Apply detected fields to the modal
			// Title
			if (detected.title && detected.title.trim()) {
				titleInput.value = detected.title;
				this.frontmatter.title = detected.title;
				appliedFields.push('title');
			}

			// Priority
			if (detected.priority) {
				priorityIcons.querySelectorAll('.edit-task-icon').forEach(i => i.removeClass('active'));
				const priorityIcon = priorityIcons.querySelector(`[title="${detected.priority}"]`);
				if (priorityIcon) {
					priorityIcon.addClass('active');
					this.frontmatter.priority = detected.priority;
					appliedFields.push('priority');
				}
			}

			// Context
			if (detected.context) {
				const contextPill = contextsContainer.querySelector(`.context-pill:not(.active)`) as HTMLElement;
				// Find and activate the matching context pill
				contextsContainer.querySelectorAll('.context-pill').forEach((pill: Element) => {
					const pillText = pill.textContent?.replace('@', '') || '';
					if (pillText === detected.context && !pill.hasClass('active')) {
						pill.addClass('active');
						appliedFields.push('context');
					}
				});
				this.updateContexts(contextsContainer);
				updateConditionalSections();
			}

			// Project
			if (detected.projects && detected.projects.length > 0) {
				const projectName = detected.projects[0];
				const projectFile = projectFiles.find(f => f.basename === projectName);
				if (projectFile) {
					projectSelect.value = projectFile.path;
					this.frontmatter.projects = [`"[[${projectFile.path}|${projectFile.basename}]]"`];
					appliedFields.push('project');
				}
			}

			// Area (only if no project)
			if (detected.area && (!detected.projects || detected.projects.length === 0)) {
				const areaOption = Array.from(areaSelect.options).find(opt => opt.value === detected.area);
				if (areaOption) {
					areaSelect.value = detected.area;
					this.frontmatter.area = `"[[gtd/areas/${detected.area}|${detected.area}]]"`;
					appliedFields.push('area');
				}
			}

			// Discuss-with
			if (detected.discuss_with && detected.discuss_with.length > 0) {
				const personName = detected.discuss_with[0];
				const personFile = personFiles.find(f => f.basename === personName);
				if (personFile) {
					discussWithSelect.value = personFile.path;
					this.frontmatter['discuss-with'] = [`"[[${personFile.path}|${personFile.basename}]]"`];
					appliedFields.push('discuss-with');
				}
			}

			// Discuss-during
			if (detected.discuss_during && detected.discuss_during.length > 0) {
				const meetingName = detected.discuss_during[0];
				const meetingFile = eventFiles.find(f =>
					f.basename === meetingName ||
					f.basename.replace(/^\d{4}-\d{2}-\d{2} \d{4} /, '') === meetingName
				);
				if (meetingFile) {
					discussDuringSelect.value = meetingFile.path;
					const displayName = meetingFile.basename.replace(/^\d{4}-\d{2}-\d{2} \d{4} /, '');
					this.frontmatter['discuss-during'] = [`"[[${meetingFile.path}|${displayName}]]"`];
					appliedFields.push('discuss-during');
				}
			}

			// Store
			if (detected.store) {
				storeInput.value = detected.store;
				this.frontmatter.store = detected.store;
				appliedFields.push('store');
			}

			// Due date (parse natural language)
			if (detected.due) {
				const dueDate = this.parseNaturalDate(detected.due, currentDate);
				if (dueDate) {
					dueInput.value = dueDate;
					this.frontmatter.due = dueDate;
					appliedFields.push('due');
				}
			}

			// Scheduled date (parse natural language)
			if (detected.scheduled) {
				const scheduledDate = this.parseNaturalDate(detected.scheduled, currentDate);
				if (scheduledDate) {
					scheduledInput.value = scheduledDate;
					this.frontmatter.scheduled = scheduledDate;
					appliedFields.push('scheduled');
				}
			}

			// Update conditional sections visibility
			updateConditionalSections();

			// Show result
			if (appliedFields.length > 0) {
				new Notice(`✨ Applied: ${appliedFields.join(', ')}`);
			} else {
				new Notice('No fields detected');
			}

		} catch (error) {
			console.error('AI suggestion failed:', error);
			new Notice('AI suggestion failed: ' + (error as Error).message);
		}
	}

	private parseNaturalDate(dateStr: string, currentDate: string): string | null {
		if (!dateStr) return null;

		const str = dateStr.toLowerCase().trim();
		const today = new Date(currentDate);

		// Handle specific patterns
		if (str === 'today') {
			return currentDate;
		}
		if (str === 'tomorrow') {
			const tomorrow = new Date(today);
			tomorrow.setDate(tomorrow.getDate() + 1);
			return tomorrow.toISOString().split('T')[0];
		}
		if (str.startsWith('next ')) {
			const dayName = str.replace('next ', '');
			const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
			const targetDay = days.indexOf(dayName);
			if (targetDay >= 0) {
				const result = new Date(today);
				const currentDay = result.getDay();
				let daysToAdd = targetDay - currentDay;
				if (daysToAdd <= 0) daysToAdd += 7;
				result.setDate(result.getDate() + daysToAdd);
				return result.toISOString().split('T')[0];
			}
		}
		// Try parsing as ISO date
		const isoMatch = str.match(/\d{4}-\d{2}-\d{2}/);
		if (isoMatch) return isoMatch[0];

		return null;
	}

	private getAIInstructions(): string {
		return `Analyze the task title and body to detect relevant GTD fields.

**Context Detection Rules:**
Suggest ONE primary context:
- "focus": Deep work (write, design, review)
- "quick": Tasks under 5 minutes (send email, reply, check)
- "relax": Low-energy tasks (read, watch, browse)
- "home"/"office"/"brf"/"school": Location-specific
- "errands": Shopping or pickup (buy, pick up, get)
- "agenda": Discussion topics (when people/meetings mentioned)
- "waiting": Waiting on something/someone

**Priority Detection:**
- "today": Urgent cues (urgent, ASAP, today, now)
- "someday": Later cues (maybe, someday, consider)
- "anytime": Default

**Date Detection:**
Return dates as natural language (e.g., "next friday", "tomorrow").

**Project/Area:**
- If project matches → return project, leave area empty
- If no project → suggest area based on keywords

**People/Meeting Detection:**
Match to available lists when discussion is mentioned.

**Store Detection:**
For errands, extract store names.

**Title Generation:**
If title can be improved (more concise, action-oriented), suggest improvement.`;
	}

	private getAIOutputSchema(): object {
		return {
			type: "object",
			properties: {
				context: { type: "string", description: "Single primary context or empty" },
				projects: { type: "array", items: { type: "string" }, description: "Detected project names" },
				area: { type: "string", description: "Suggested area if no projects" },
				priority: { type: "string", enum: ["anytime", "today", "someday"] },
				scheduled: { type: "string", description: "Natural language scheduled date" },
				due: { type: "string", description: "Natural language due date" },
				discuss_with: { type: "array", items: { type: "string" }, description: "People to discuss with" },
				discuss_during: { type: "array", items: { type: "string" }, description: "Meetings" },
				store: { type: "string", description: "Store name for errands" },
				title: { type: "string", description: "Suggested title improvement" },
				confidence_scores: {
					type: "object",
					properties: {
						context: { type: "number" },
						projects: { type: "number" },
						area: { type: "number" },
						priority: { type: "number" },
						scheduled: { type: "number" },
						due: { type: "number" },
						discuss_with: { type: "number" },
						discuss_during: { type: "number" },
						store: { type: "number" },
						title: { type: "number" }
					}
				}
			},
			required: ["context", "projects", "area", "priority", "scheduled", "due", "discuss_with", "discuss_during", "store", "title", "confidence_scores"]
		};
	}

	private formatDateForInput(dateValue: any): string {
		if (!dateValue) return '';
		const str = String(dateValue).replace(/^["']|["']$/g, '');
		// Handle Luxon DateTime or ISO string
		if (str.length >= 10) {
			return str.substring(0, 10);
		}
		return '';
	}

	private getArrayField(field: string): string[] {
		const value = this.frontmatter[field];
		if (Array.isArray(value)) {
			return value.map(v => String(v).replace(/^["']|["']$/g, ''));
		}
		return [];
	}

	private getProjectBasename(): string {
		const projects = this.frontmatter.projects;
		if (Array.isArray(projects) && projects.length > 0) {
			const projStr = String(projects[0]);
			const match = projStr.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
			if (match) {
				return match[2] || match[1].split('/').pop()?.replace(/\.md$/, '') || '';
			}
		}
		return '';
	}

	private getAreaName(): string {
		const area = this.frontmatter.area;
		if (!area) return '';
		const areaStr = String(area).replace(/^["']|["']$/g, '');
		const match = areaStr.match(/\|([^\]]+)\]\]/);
		return match ? match[1] : '';
	}

	private getDiscussWithBasename(): string {
		const discussWith = this.frontmatter['discuss-with'];
		if (Array.isArray(discussWith) && discussWith.length > 0) {
			const str = String(discussWith[0]);
			const match = str.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
			if (match) {
				return match[2] || match[1].split('/').pop()?.replace(/\.md$/, '') || '';
			}
		}
		return '';
	}

	private getDiscussDuringBasename(): string {
		const discussDuring = this.frontmatter['discuss-during'];
		if (Array.isArray(discussDuring) && discussDuring.length > 0) {
			const str = String(discussDuring[0]);
			const match = str.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
			if (match) {
				return match[2] || match[1].split('/').pop()?.replace(/\.md$/, '') || '';
			}
		}
		return '';
	}

	private updateContexts(container: HTMLElement): void {
		const activePills = container.querySelectorAll('.context-pill.active');
		const contexts: string[] = [];
		activePills.forEach(pill => {
			const text = pill.textContent?.replace('@', '') || '';
			if (text) contexts.push(text);
		});
		this.frontmatter.contexts = contexts;
	}

	private getActiveContexts(container: HTMLElement): string[] {
		const activePills = container.querySelectorAll('.context-pill.active');
		const contexts: string[] = [];
		activePills.forEach(pill => {
			const text = pill.textContent?.replace('@', '') || '';
			if (text) contexts.push(text);
		});
		return contexts;
	}

	async saveChanges(): Promise<void> {
		// Update dateModified
		this.frontmatter.dateModified = new Date().toISOString();

		// Rebuild content
		const newContent = this.plugin.rebuildContent(this.frontmatter, this.body);

		if (this.isCreateMode) {
			// Create mode - create the file now
			await this.app.vault.create(this.taskPath, newContent);
			new Notice('Action created');
		} else {
			// Edit mode - update existing file
			const file = this.app.vault.getAbstractFileByPath(this.taskPath);
			if (!file || !(file instanceof TFile)) {
				new Notice('Error: Task file not found');
				return;
			}
			await this.app.vault.modify(file, newContent);
			new Notice('Task updated');
		}

		this.didSave = true;
		this.close();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();

		// Refresh dataview if we saved or deleted
		if (this.didSave) {
			this.plugin.refreshDataview();
		}
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
			const timestamp = this.generateTimestamp();
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
			const parsed = this.parseFrontmatter(content);
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
		return `<div class="minimal-task-controls">${this.renderPriorityBadge(priority, path)}${this.renderStatusDot(status, path)}</div>`;
	}

	private createContent(task: EnrichedTask, hasNotes: boolean, isCompleted: boolean, showContexts: boolean, excludePills: string[], path: string): string {
		const title = this.createTitle(task, isCompleted);
		const editIcon = `<span class="minimal-task-edit-icon" data-task-path="${path}" title="Edit task">⊙</span>`;
		const noteIcon = hasNotes && this.settings.showNoteIcon
			? '<span class="minimal-task-note-icon">›</span>'
			: '';
		const metadata = this.createMetadata(task, showContexts, excludePills);

		return `<div class="minimal-task-content">${title}${noteIcon}${editIcon}${metadata}</div>`;
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
		const priorityBadge = this.renderPriorityBadge(priority, path);
		const statusDot = this.renderStatusDot(status, path);

		const completedClass = isCompleted ? ' is-completed' : '';
		const titleHtml = `<a class="internal-link${completedClass}" data-href="${hrefPath}" href="${hrefPath}">${this.escapeHtml(title)}</a>`;

		const noteIcon = hasNotes && this.settings.showNoteIcon
			? '<span class="minimal-task-note-icon"> ›</span>'
			: '';

		const editIcon = `<span class="minimal-task-edit-icon" data-task-path="${path}" title="Edit task"> ⊙</span>`;

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
			badges.push(this.renderRecurrencePill(rrule));
		}

		const contexts = fm[this.settings.contextsField] || [];
		if (contexts.length > 0) {
			badges.push(this.renderContextPills(contexts));
		}

		const projects = fm[this.settings.projectField] || [];
		if (projects.length > 0) {
			badges.push(this.renderProjectPills(projects));
		}

		const metadata = badges.length > 0
			? ` <span class="minimal-task-metadata">${badges.join('')}</span>`
			: '';

		return `${priorityBadge}${statusDot} ${titleHtml}${noteIcon}${editIcon}${metadata}`;
	}

	/**
	 * Render project pills (for inline task display)
	 */
	renderProjectPills(projects: string | string[]): string {
		return (Array.isArray(projects) ? projects : [projects])
			.filter(p => p)
			.map(project => {
				const displayName = this.extractDisplayName(project);
				const linkPath = this.extractLinkPath(project);
				if (linkPath) {
					return `<span class="minimal-badge minimal-badge-project"><a class="internal-link" data-href="${linkPath}" href="${linkPath}">📁 ${this.escapeHtml(displayName)}</a></span>`;
				}
				return `<span class="minimal-badge minimal-badge-project">📁 ${this.escapeHtml(displayName)}</span>`;
			})
			.join('');
	}

	/**
	 * Escape HTML special characters
	 */
	private escapeHtml(text: string): string {
		const div = document.createElement('div');
		div.textContent = text;
		return div.textContent || '';
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

	formatRRuleReadable(rrule: string): string {
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
			} else if (freq === 'MONTHLY' && interval === 3) {
				text = "Quarterly";
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

	parseRRule(rrule: string): Record<string, string> {
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

	formatDTSTART(dateStr: string): string {
		const d = new Date(dateStr);
		const year = d.getFullYear();
		const month = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${year}${month}${day}`;
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
			const { frontmatter } = this.parseFrontmatter(content);

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
			const timestamp = this.generateTimestamp();
			const filename = `${timestamp}.md`;
			const path = `gtd/actions/${filename}`;

			// 3. Build frontmatter
			const actionFrontmatter = this.buildConvertFrontmatter(taskText, context);

			// 4. Create action file
			const actionContent = this.buildActionContent(actionFrontmatter);
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
