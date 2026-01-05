import { App, PluginSettingTab, Setting } from 'obsidian';
import type { MinimalTasksSettings } from '../types';

// Forward reference to avoid circular dependency
interface MinimalTasksPluginInterface {
	settings: MinimalTasksSettings;
	saveSettings(): Promise<void>;
}

export class MinimalTasksSettingTab extends PluginSettingTab {
	plugin: MinimalTasksPluginInterface;

	constructor(app: App, plugin: MinimalTasksPluginInterface) {
		super(app, plugin as any);
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
			.setName('Note content ignore pattern')
			.setDesc('Regex pattern to ignore when detecting note content. Useful for stripping boilerplate code blocks like ribbons. Leave empty to disable.')
			.addTextArea(text => text
				.setPlaceholder('^\\s*```dataviewjs\\s*\\n\\s*await dv\\.view\\("(?:apps\\/dataview\\/)?unified-ribbon"\\);?\\s*\\n\\s*```\\s*')
				.setValue(this.plugin.settings.noteContentIgnorePattern)
				.onChange(async (value) => {
					this.plugin.settings.noteContentIgnorePattern = value;
					await this.plugin.saveSettings();
				}));

		// Note Type Detection Section
		containerEl.createEl('h3', { text: 'Note Type Detection' });
		containerEl.createEl('p', {
			text: 'Configure how different note types are identified in your vault.',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Person type field')
			.setDesc('Frontmatter field to identify person notes')
			.addText(text => text
				.setPlaceholder('type')
				.setValue(this.plugin.settings.personTypeField)
				.onChange(async (value) => {
					this.plugin.settings.personTypeField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Person type value')
			.setDesc('Value that identifies a note as a person')
			.addText(text => text
				.setPlaceholder('person')
				.setValue(this.plugin.settings.personTypeValue)
				.onChange(async (value) => {
					this.plugin.settings.personTypeValue = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Event type field')
			.setDesc('Frontmatter field to identify event notes')
			.addText(text => text
				.setPlaceholder('type')
				.setValue(this.plugin.settings.eventTypeField)
				.onChange(async (value) => {
					this.plugin.settings.eventTypeField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Event type value')
			.setDesc('Value that identifies a note as an event')
			.addText(text => text
				.setPlaceholder('event')
				.setValue(this.plugin.settings.eventTypeValue)
				.onChange(async (value) => {
					this.plugin.settings.eventTypeValue = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Project type field')
			.setDesc('Frontmatter field to identify project notes')
			.addText(text => text
				.setPlaceholder('type')
				.setValue(this.plugin.settings.projectTypeField)
				.onChange(async (value) => {
					this.plugin.settings.projectTypeField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Project type value')
			.setDesc('Value that identifies a note as a project')
			.addText(text => text
				.setPlaceholder('project')
				.setValue(this.plugin.settings.projectTypeValue)
				.onChange(async (value) => {
					this.plugin.settings.projectTypeValue = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Action type field')
			.setDesc('Frontmatter field to identify action/task notes')
			.addText(text => text
				.setPlaceholder('type')
				.setValue(this.plugin.settings.actionTypeField)
				.onChange(async (value) => {
					this.plugin.settings.actionTypeField = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Action type value')
			.setDesc('Value that identifies a note as an action/task')
			.addText(text => text
				.setPlaceholder('action')
				.setValue(this.plugin.settings.actionTypeValue)
				.onChange(async (value) => {
					this.plugin.settings.actionTypeValue = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Areas folder')
			.setDesc('Folder containing area notes. Use "order" (number) and "emoji" frontmatter fields in area notes to control sorting and display.')
			.addText(text => text
				.setPlaceholder('gtd/areas/')
				.setValue(this.plugin.settings.areasFolder)
				.onChange(async (value) => {
					this.plugin.settings.areasFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Contexts folder')
			.setDesc('Folder containing context notes (e.g., @focus.md). Use "order" (number) frontmatter field to control sorting. Context name is derived from filename without @ prefix.')
			.addText(text => text
				.setPlaceholder('gtd/contexts/')
				.setValue(this.plugin.settings.contextsFolder)
				.onChange(async (value) => {
					this.plugin.settings.contextsFolder = value;
					await this.plugin.saveSettings();
				}));
	}
}
