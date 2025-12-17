// Type definitions for Minimal Tasks plugin

export interface MinimalTasksSettings {
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

	// Note type detection
	personTypeField: string;
	personTypeValue: string;
	eventTypeField: string;
	eventTypeValue: string;
	projectTypeField: string;
	projectTypeValue: string;
	actionTypeField: string;
	actionTypeValue: string;
	areasFolder: string;
}

export interface DataviewAPI {
	fileLink: (path: string, embed?: boolean, display?: string) => string;
	page: (path: string) => any;
	date: (dateStr: string) => any;
}

export interface TaskFile {
	path: string;
	ctime?: number;
}

export interface EnrichedTask {
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

export interface ProjectMeta {
	link: string;
	due?: string;
	dueFormatted?: string;
	overdue?: boolean;
}

export interface ProcessedTask {
	task: any;
	hasNotes: boolean;
	enrichedTask: EnrichedTask;
}

export interface RenderOptions {
	hasNotes?: boolean;
	showProjects?: boolean;
	showContexts?: boolean;
	excludePills?: string[];
}

export interface Frontmatter {
	[key: string]: any;
}

export interface ParsedContent {
	frontmatter: Frontmatter;
	body: string;
}

export interface StatusOption {
	value: string;
	label: string;
	icon: string;
}

export interface PriorityOption {
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
