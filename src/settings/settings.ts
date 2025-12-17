import { MinimalTasksSettings } from '../types';

export const DEFAULT_SETTINGS: MinimalTasksSettings = {
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
	priorities: ['anytime', 'today', 'someday'],

	// Note type detection
	personTypeField: 'type',
	personTypeValue: 'person',
	eventTypeField: 'type',
	eventTypeValue: 'event',
	projectTypeField: 'type',
	projectTypeValue: 'project',
	actionTypeField: 'type',
	actionTypeValue: 'action',
	areasFolder: 'gtd/areas/'
};
