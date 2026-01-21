import { App, Modal, Notice, TFile } from 'obsidian';
import type { Frontmatter, MinimalTasksSettings } from '../types';
import { parseFrontmatter, rebuildContent } from '../frontmatter';
import { parseRRule } from '../recurrence';
import { formatDTSTART, formatDateForInput } from '../utils';

// Interface for plugin dependencies to avoid circular imports
interface MinimalTasksPluginInterface {
	app: App;
	settings: MinimalTasksSettings;
	refreshDataview(): void;
}

export class EditTaskModal extends Modal {
	private taskPath: string;
	private plugin: MinimalTasksPluginInterface;
	private frontmatter: Frontmatter = {};
	private body: string = '';
	private isCreateMode: boolean = false;
	private didSave: boolean = false;

	constructor(app: App, plugin: MinimalTasksPluginInterface, taskPath: string, initialFrontmatter?: Frontmatter, initialBody?: string) {
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
		// Add class to the outer modal element for proper CSS targeting
		this.modalEl.addClass('edit-task-modal');

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
		const parsed = parseFrontmatter(content);
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

		const allContexts = this.getContextsFromFolder();
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

		// Get areas from configured folder (with order and emoji from frontmatter)
		const areaData = this.getAreasFromFolder();
		const areaEmoji: Record<string, string> = {};
		areaData.forEach(a => { areaEmoji[a.name] = a.emoji; });
		const areaOrder = [...areaData.map(a => a.name), ""];

		// Get projects from vault with area info (using frontmatter type detection)
		const projectFiles = this.getNotesOfType(
			this.plugin.settings.projectTypeField,
			this.plugin.settings.projectTypeValue
		).filter(f => {
			const cache = this.app.metadataCache.getFileCache(f);
			return cache?.frontmatter?.state !== 'completed';
		})
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

		const currentArea = this.getAreaName();
		// Add empty option first
		areaSelect.createEl('option', { value: '', text: '(none)' });
		// Add areas in order with emojis from frontmatter
		areaData.forEach(a => {
			const text = `${a.emoji} ${a.name}`;
			const opt = areaSelect.createEl('option', { value: a.name, text });
			if (a.name === currentArea) opt.selected = true;
		});
		areaSelect.addEventListener('change', () => {
			if (areaSelect.value) {
				this.frontmatter.area = `"[[${this.plugin.settings.areasFolder}${areaSelect.value}|${areaSelect.value}]]"`;
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

		const personFiles = this.getNotesOfType(
			this.plugin.settings.personTypeField,
			this.plugin.settings.personTypeValue
		).sort((a, b) => a.basename.localeCompare(b.basename));

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
		const eventFiles = this.getNotesOfType(
			this.plugin.settings.eventTypeField,
			this.plugin.settings.eventTypeValue
		)
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
		this.getNotesOfType(
			this.plugin.settings.actionTypeField,
			this.plugin.settings.actionTypeValue
		).forEach(f => {
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
				value: formatDateForInput(this.frontmatter.scheduled)
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
				value: formatDateForInput(this.frontmatter.due)
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
		recurrenceGroup.createSpan({ cls: 'edit-task-label', text: '🔁 Every' });

		// Day names and codes (European order: Monday first)
		const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
		const dayCodes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

		// Interval input (1, 2, 3...)
		const intervalInput = recurrenceGroup.createEl('input', {
			cls: 'edit-task-input-small',
			attr: { type: 'number', min: '1', max: '99', value: '1' }
		});
		intervalInput.style.width = '45px';
		intervalInput.style.display = 'none';

		// Unit select (day, week, month, year)
		const unitSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		unitSelect.createEl('option', { value: '', text: '(none)' });
		unitSelect.createEl('option', { value: 'day', text: 'day' });
		unitSelect.createEl('option', { value: 'week', text: 'week' });
		unitSelect.createEl('option', { value: 'month', text: 'month' });
		unitSelect.createEl('option', { value: 'year', text: 'year' });

		// "on" label (shown for week/month/year)
		const onLabel = recurrenceGroup.createSpan({ cls: 'edit-task-label', text: 'on' });
		onLabel.style.display = 'none';

		// Day of week dropdown (for weekly)
		const dayOfWeekSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		dayNames.forEach((day, i) => {
			dayOfWeekSelect.createEl('option', { value: dayCodes[i], text: day });
		});
		dayOfWeekSelect.style.display = 'none';

		// Monthly mode dropdown (day of month vs weekday) - Things 3 style
		const monthlyModeSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		monthlyModeSelect.createEl('option', { value: 'day', text: 'day' });
		dayNames.forEach((day, i) => {
			monthlyModeSelect.createEl('option', { value: dayCodes[i], text: day });
		});
		monthlyModeSelect.style.display = 'none';

		// Position dropdown for monthly weekday (1st, 2nd, 3rd, 4th, last)
		const positionSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		const positions = [
			{ label: '1st', value: '1' },
			{ label: '2nd', value: '2' },
			{ label: '3rd', value: '3' },
			{ label: '4th', value: '4' },
			{ label: 'last', value: '-1' }
		];
		positions.forEach(p => {
			positionSelect.createEl('option', { value: p.value, text: p.label });
		});
		positionSelect.style.display = 'none';

		// Day of month dropdown (for monthly when mode is 'day')
		const dayOfMonthSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		for (let i = 1; i <= 31; i++) {
			const suffix = i === 1 || i === 21 || i === 31 ? 'st' : i === 2 || i === 22 ? 'nd' : i === 3 || i === 23 ? 'rd' : 'th';
			dayOfMonthSelect.createEl('option', { value: String(i), text: `${i}${suffix}` });
		}
		dayOfMonthSelect.style.display = 'none';

		// Month dropdown (for yearly)
		const monthSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
		monthNames.forEach((month, i) => {
			monthSelect.createEl('option', { value: String(i + 1), text: month });
		});
		monthSelect.style.display = 'none';

		// Yearly mode dropdown (day of month vs weekday) - like monthly
		const yearlyModeSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		yearlyModeSelect.createEl('option', { value: 'day', text: 'day' });
		dayNames.forEach((day, i) => {
			yearlyModeSelect.createEl('option', { value: dayCodes[i], text: day });
		});
		yearlyModeSelect.style.display = 'none';

		// Position dropdown for yearly weekday (reuse same values as monthly)
		const yearlyPositionSelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		positions.forEach(p => {
			yearlyPositionSelect.createEl('option', { value: p.value, text: p.label });
		});
		yearlyPositionSelect.style.display = 'none';

		// Day dropdown for yearly (when mode is 'day')
		const yearDaySelect = recurrenceGroup.createEl('select', { cls: 'edit-task-select-small' });
		for (let i = 1; i <= 31; i++) {
			yearDaySelect.createEl('option', { value: String(i), text: String(i) });
		}
		yearDaySelect.style.display = 'none';

		// Start date group
		const startGroup = recurrenceRow.createDiv({ cls: 'edit-task-inline-group' });
		startGroup.createSpan({ cls: 'edit-task-label', text: 'from' });
		const recurrenceStartInput = startGroup.createEl('input', {
			cls: 'edit-task-date-input-small',
			attr: { type: 'date' }
		});
		startGroup.style.display = 'none';

		// Parse current rrule
		const currentRRule = String(this.frontmatter.rrule || '').replace(/^["']|["']$/g, '');
		let currentUnit = '';
		let currentInterval = 1;
		let currentDayCode = dayCodes[(new Date().getDay() + 6) % 7]; // Convert JS day (0=Sun) to European index (0=Mon)
		let currentMonthDay = new Date().getDate();
		let currentMonth = new Date().getMonth() + 1;
		let currentMonthlyMode = 'day'; // 'day' or weekday code like 'SA'
		let currentYearlyMode = 'day'; // 'day' or weekday code like 'SA'
		let currentPosition = '1'; // 1, 2, 3, 4, or -1 (last)
		let currentYearlyPosition = '1'; // 1, 2, 3, 4, or -1 (last)
		let currentStartDate = this.frontmatter.recurrence_start
			? String(this.frontmatter.recurrence_start).replace(/^["']|["']$/g, '')
			: scheduledInput.value || new Date().toISOString().split('T')[0];

		if (currentRRule) {
			const parts = parseRRule(currentRRule);
			// Extract DTSTART if present
			if (parts.DTSTART) {
				const ds = parts.DTSTART;
				if (ds.length === 8) {
					currentStartDate = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`;
				}
			}
			currentInterval = parseInt(parts.INTERVAL || '1');

			if (parts.FREQ === 'DAILY') {
				currentUnit = 'day';
			} else if (parts.FREQ === 'WEEKLY') {
				currentUnit = 'week';
				if (parts.BYDAY) currentDayCode = parts.BYDAY;
			} else if (parts.FREQ === 'MONTHLY') {
				currentUnit = 'month';
				if (parts.BYSETPOS && parts.BYDAY) {
					currentMonthlyMode = parts.BYDAY;
					currentPosition = parts.BYSETPOS;
				} else if (parts.BYMONTHDAY) {
					currentMonthlyMode = 'day';
					currentMonthDay = parseInt(parts.BYMONTHDAY);
				}
			} else if (parts.FREQ === 'YEARLY') {
				currentUnit = 'year';
				if (parts.BYMONTH) currentMonth = parseInt(parts.BYMONTH);
				// Check for positional weekday (BYSETPOS + BYDAY)
				if (parts.BYSETPOS && parts.BYDAY) {
					currentYearlyMode = parts.BYDAY;
					currentYearlyPosition = parts.BYSETPOS;
				} else if (parts.BYMONTHDAY) {
					currentYearlyMode = 'day';
					currentMonthDay = parseInt(parts.BYMONTHDAY);
				}
			}
		}

		// Set initial values
		unitSelect.value = currentUnit;
		intervalInput.value = String(currentInterval);
		dayOfWeekSelect.value = currentDayCode;
		dayOfMonthSelect.value = String(currentMonthDay);
		monthSelect.value = String(currentMonth);
		yearDaySelect.value = String(currentMonthDay);
		monthlyModeSelect.value = currentMonthlyMode;
		yearlyModeSelect.value = currentYearlyMode;
		positionSelect.value = currentPosition;
		yearlyPositionSelect.value = currentYearlyPosition;
		recurrenceStartInput.value = currentStartDate;

		// Update visibility of detail selects
		const updateDetailVisibility = () => {
			const unit = unitSelect.value;
			const monthlyMode = monthlyModeSelect.value;
			const yearlyMode = yearlyModeSelect.value;
			const isMonthlyWeekdayMode = unit === 'month' && monthlyMode !== 'day';
			const isYearlyWeekdayMode = unit === 'year' && yearlyMode !== 'day';

			// Show interval when a unit is selected
			intervalInput.style.display = unit ? '' : 'none';

			// Show "on" label for week/month/year
			onLabel.style.display = (unit === 'week' || unit === 'month' || unit === 'year') ? '' : 'none';

			// Week: show day of week
			dayOfWeekSelect.style.display = unit === 'week' ? '' : 'none';

			// Month: show mode selector, then either position or day-of-month
			monthlyModeSelect.style.display = unit === 'month' ? '' : 'none';
			positionSelect.style.display = isMonthlyWeekdayMode ? '' : 'none';
			dayOfMonthSelect.style.display = (unit === 'month' && !isMonthlyWeekdayMode) ? '' : 'none';

			// Year: show month, then mode selector, then either position or day
			monthSelect.style.display = unit === 'year' ? '' : 'none';
			yearlyModeSelect.style.display = unit === 'year' ? '' : 'none';
			yearlyPositionSelect.style.display = isYearlyWeekdayMode ? '' : 'none';
			yearDaySelect.style.display = (unit === 'year' && !isYearlyWeekdayMode) ? '' : 'none';

			// Start date group
			startGroup.style.display = unit ? '' : 'none';
		};
		updateDetailVisibility();

		// Update visibility when monthly/yearly mode changes
		monthlyModeSelect.addEventListener('change', updateDetailVisibility);
		yearlyModeSelect.addEventListener('change', updateDetailVisibility);

		// Generate rrule from current selections
		const generateRRule = (): string => {
			const startDate = recurrenceStartInput.value || scheduledInput.value || new Date().toISOString().split('T')[0];
			const dtstart = formatDTSTART(startDate);
			const unit = unitSelect.value;
			const interval = parseInt(intervalInput.value) || 1;

			switch (unit) {
				case 'day':
					return `DTSTART:${dtstart};FREQ=DAILY;INTERVAL=${interval}`;
				case 'week':
					return `DTSTART:${dtstart};FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${dayOfWeekSelect.value}`;
				case 'month':
					if (monthlyModeSelect.value !== 'day') {
						return `DTSTART:${dtstart};FREQ=MONTHLY;INTERVAL=${interval};BYDAY=${monthlyModeSelect.value};BYSETPOS=${positionSelect.value}`;
					}
					return `DTSTART:${dtstart};FREQ=MONTHLY;INTERVAL=${interval};BYMONTHDAY=${dayOfMonthSelect.value}`;
				case 'year':
					if (yearlyModeSelect.value !== 'day') {
						return `DTSTART:${dtstart};FREQ=YEARLY;INTERVAL=${interval};BYMONTH=${monthSelect.value};BYDAY=${yearlyModeSelect.value};BYSETPOS=${yearlyPositionSelect.value}`;
					}
					return `DTSTART:${dtstart};FREQ=YEARLY;INTERVAL=${interval};BYMONTH=${monthSelect.value};BYMONTHDAY=${yearDaySelect.value}`;
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

		unitSelect.addEventListener('change', () => {
			updateDetailVisibility();
			updateRecurrence();
		});
		intervalInput.addEventListener('change', updateRecurrence);
		dayOfWeekSelect.addEventListener('change', updateRecurrence);
		dayOfMonthSelect.addEventListener('change', updateRecurrence);
		monthlyModeSelect.addEventListener('change', updateRecurrence);
		positionSelect.addEventListener('change', updateRecurrence);
		monthSelect.addEventListener('change', updateRecurrence);
		yearlyModeSelect.addEventListener('change', updateRecurrence);
		yearlyPositionSelect.addEventListener('change', updateRecurrence);
		yearDaySelect.addEventListener('change', updateRecurrence);
		recurrenceStartInput.addEventListener('change', updateRecurrence);

		// Status & Priority section (icon toggles)
		const statusPrioritySection = contentEl.createDiv({ cls: 'edit-task-section' });
		const statusPriorityRow = statusPrioritySection.createDiv({ cls: 'edit-task-row-inline' });

		// Status icons
		const statusGroup = statusPriorityRow.createDiv({ cls: 'edit-task-inline-group' });
		statusGroup.createSpan({ cls: 'edit-task-label', text: 'Status' });
		const statusIcons = statusGroup.createDiv({ cls: 'edit-task-icon-group' });

		const statusValues = ['none', 'open', 'in-progress', 'done', 'dropped'];

		const currentStatus = this.frontmatter.status || 'none';
		statusValues.forEach(status => {
			const dot = statusIcons.createSpan({
				cls: 'task-status-dot' + (currentStatus === status ? ' selected' : ''),
				attr: { 'data-status': status, title: status }
			});
			dot.addEventListener('click', () => {
				statusIcons.querySelectorAll('.task-status-dot').forEach(d => d.removeClass('selected'));
				dot.addClass('selected');
				this.frontmatter.status = status;
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

		// Notes section (textarea for body content)
		const notesSection = contentEl.createDiv({ cls: 'edit-task-section' });
		notesSection.createDiv({ cls: 'edit-task-section-label', text: 'Notes' });
		const notesTextarea = notesSection.createEl('textarea', {
			cls: 'edit-task-notes-input',
			attr: {
				placeholder: 'Add notes...',
				rows: '3'
			}
		});

		// Extract user content from body (after the dataviewjs ribbon block)
		const ribbonBlock = '```dataviewjs\nawait dv.view("apps/dataview/unified-ribbon");\n```\n';
		const ribbonEnd = this.body.indexOf('```\n', this.body.indexOf('```dataviewjs'));
		const userContent = ribbonEnd !== -1
			? this.body.substring(ribbonEnd + 4).trim()
			: '';
		notesTextarea.value = userContent;

		notesTextarea.addEventListener('input', () => {
			// Rebuild body: ribbon + user content
			const userText = notesTextarea.value.trim();
			this.body = userText ? ribbonBlock + '\n' + userText : ribbonBlock;
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

			// Get available projects (using frontmatter type detection)
			const projectFiles = this.getNotesOfType(
				this.plugin.settings.projectTypeField,
				this.plugin.settings.projectTypeValue
			);
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

			// Get available people (using frontmatter type detection)
			const personFiles = this.getNotesOfType(
				this.plugin.settings.personTypeField,
				this.plugin.settings.personTypeValue
			);
			const people = personFiles.map(f => f.basename);

			// Get available meetings (future events, using frontmatter type detection)
			const eventFiles = this.getNotesOfType(
				this.plugin.settings.eventTypeField,
				this.plugin.settings.eventTypeValue
			);
			const meetings = eventFiles
				.filter(f => {
					const cache = this.app.metadataCache.getFileCache(f);
					const eventDate = cache?.frontmatter?.date;
					if (!eventDate) return true;
					return eventDate >= currentDate;
				})
				.map(f => f.basename);

			// Get available stores (using frontmatter type detection)
			const existingStores = new Set<string>();
			this.getNotesOfType(
				this.plugin.settings.actionTypeField,
				this.plugin.settings.actionTypeValue
			).forEach(f => {
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
					available_contexts: this.getContextsFromFolder(),
					available_projects: projects,
					available_areas: this.getAreasFromFolder().map(a => a.name),
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
					// Clear area since it will be inherited from project
					areaSelect.value = '';
					delete this.frontmatter.area;
				}
			}

			// Area (only if no project)
			if (detected.area && (!detected.projects || detected.projects.length === 0)) {
				const areaOption = Array.from(areaSelect.options).find(opt => opt.value === detected.area);
				if (areaOption) {
					areaSelect.value = detected.area;
					this.frontmatter.area = `"[[${this.plugin.settings.areasFolder}${detected.area}|${detected.area}]]"`;
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

	/**
	 * Get notes of a specific type based on frontmatter field/value
	 */
	private getNotesOfType(typeField: string, typeValue: string): TFile[] {
		return this.app.vault.getMarkdownFiles().filter(f => {
			const cache = this.app.metadataCache.getFileCache(f);
			return cache?.frontmatter?.[typeField] === typeValue;
		});
	}

	/**
	 * Get areas from the configured areas folder with order and emoji from frontmatter
	 */
	private getAreasFromFolder(): Array<{name: string, order: number, emoji: string}> {
		const areasFolder = this.plugin.settings.areasFolder;
		return this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith(areasFolder))
			.map(f => {
				const cache = this.app.metadataCache.getFileCache(f);
				const order = cache?.frontmatter?.order ?? 999;
				const emoji = cache?.frontmatter?.emoji ?? '📦';
				return { name: f.basename, order, emoji };
			})
			.sort((a, b) => a.order - b.order);
	}

	/**
	 * Get contexts from the configured contexts folder with order from frontmatter
	 * Context names are derived from filenames, stripping the @ prefix
	 */
	private getContextsFromFolder(): string[] {
		const contextsFolder = this.plugin.settings.contextsFolder;
		return this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith(contextsFolder))
			.map(f => {
				const cache = this.app.metadataCache.getFileCache(f);
				const order = cache?.frontmatter?.order ?? 999;
				// Strip @ prefix from filename to get context name
				const name = f.basename.startsWith('@') ? f.basename.slice(1) : f.basename;
				return { name, order };
			})
			.sort((a, b) => a.order - b.order)
			.map(c => c.name);
	}

	async saveChanges(): Promise<void> {
		// Update dateModified
		this.frontmatter.dateModified = new Date().toISOString();

		// Rebuild content
		const newContent = rebuildContent(this.frontmatter, this.body);

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
