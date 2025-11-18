# Minimal Tasks

A lightweight Obsidian plugin for interactive task rendering in DataviewJS lists. Features clickable status dots and priority badges with right-click menus for quick task updates.

## Features

- **Interactive Status Dots**: Color-coded dots indicating task status
  - Left-click to cycle through: none → open → in-progress → done → dropped
  - Right-click for menu selection
- **Priority Badges**: Visual indicators for task priority
  - Left-click to cycle: anytime → today → someday
  - Right-click for menu selection
- **Date Badges**: Automatic display of scheduled and due dates
  - Overdue warnings with red background
- **Project Links**: Show project relationships with due date indicators
- **Metadata Pills**: Display contexts, people, meetings, and locations
- **Customizable Fields**: Configure all frontmatter field names in settings

## Installation

1. Copy the `minimal-tasks` folder to your vault's `.obsidian/plugins/` directory
2. Reload Obsidian or restart the app
3. Enable "Minimal Tasks" in Settings → Community plugins

## Requirements

- **Dataview plugin**: Required for querying and rendering tasks
- **Task structure**: Tasks as individual markdown files with YAML frontmatter

## Basic Usage

### Simple Task List

```dataviewjs
const tasks = dv.pages('"tasks"')
    .where(t => t.status != "done");

dv.paragraph(await window.MinimalTasks.renderTaskList(dv, tasks));
```

### With Filtering

```dataviewjs
// Tasks with specific context
const tasks = dv.pages('"gtd/actions"')
    .where(t => t.contexts?.includes("focus"))
    .where(t => t.status != "done");

dv.paragraph(await window.MinimalTasks.renderTaskList(dv, tasks, {
    showProjects: true,
    showContexts: false
}));
```

### With Options

```dataviewjs
const tasks = dv.pages('"tasks"')
    .where(t => t.priority == "today");

dv.paragraph(await window.MinimalTasks.renderTaskList(dv, tasks, {
    showProjects: true,          // Show project links below tasks
    showContexts: true,           // Show context pills
    excludePills: ['person']      // Hide specific pill types
}));
```

## Configuration

### Plugin Settings

Go to Settings → Minimal Tasks to customize:

**Frontmatter Field Names** - Configure which frontmatter fields to use:
- Status field (default: `status`)
- Priority field (default: `priority`)
- Projects field (default: `projects`)
- Contexts field (default: `contexts`)
- Due date field (default: `due`)
- Scheduled field (default: `scheduled`)
- And more...

**Display Options**:
- Show projects below tasks
- Show project due dates
- Show note icon for tasks with content

### Task Frontmatter Structure

Example task file (`tasks/my-task.md`):

```yaml
---
status: open              # none, open, in-progress, done, dropped
priority: today           # anytime, today, someday
title: "Task title"
contexts: [focus, home]   # Array of contexts
projects: ["[[Project Name]]"]  # Array of project links
due: 2025-11-19          # Deadline
scheduled: 2025-11-18    # When available to work on
discuss-with: ["[[Person Name]]"]  # For agenda items
discuss-during: ["[[Meeting]]"]    # Which meeting
store: "Store Name"      # For errands
---
```

## Rendering Options

The `renderTaskList` method accepts these options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `showProjects` | boolean | true | Show project links below tasks |
| `showContexts` | boolean | false | Show context pills |
| `excludePills` | array | [] | Hide specific pill types: `'person'`, `'meeting'`, `'store'`, `'contexts'` |

## Status and Priority Values

### Status Options
- `none` - No status (gray dot)
- `open` - Open for work (blue dot)
- `in-progress` - Currently working (yellow dot)
- `done` - Completed (green dot)
- `dropped` - Abandoned (red dot)

### Priority Options
- `anytime` - Regular task (• bullet)
- `today` - Focus on today (⭐ star)
- `someday` - Future consideration (💭 thought bubble)

## Advanced Usage

### Custom Queries

```dataviewjs
// Combine multiple filters
const tasks = dv.pages('"tasks"')
    .where(t => t.status == "in-progress" || t.priority == "today")
    .where(t => !t.scheduled || dv.date(t.scheduled) <= dv.date('today'))
    .where(t => t.contexts?.some(c => ["focus", "quick"].includes(c)));

dv.paragraph(await window.MinimalTasks.renderTaskList(dv, tasks));
```

### Group by Context

```dataviewjs
const contexts = ["focus", "quick", "home"];

for (const ctx of contexts) {
    dv.header(3, ctx);

    const tasks = dv.pages('"tasks"')
        .where(t => t.contexts?.includes(ctx))
        .where(t => t.status != "done");

    if (tasks.length > 0) {
        dv.paragraph(await window.MinimalTasks.renderTaskList(dv, tasks, {
            showContexts: false  // Hide context pills since we're grouping by context
        }));
    } else {
        dv.paragraph(`*No ${ctx} tasks*`);
    }
}
```

## API Reference

### `window.MinimalTasks.renderTaskList(dv, tasks, options)`

Main method for rendering task lists with automatic enrichment.

**Parameters:**
- `dv` (Object) - Dataview API object
- `tasks` (Array|DataArray) - Array of Dataview page objects
- `options` (Object) - Optional rendering options

**Returns:** Promise<string> - HTML string

**Features:**
- Automatically checks for note content
- Enriches project metadata with due dates
- Generates proper Obsidian links
- Sorts tasks by priority
- Handles all metadata rendering

### `window.MinimalTasks.renderTask(task, options)`

Lower-level method for rendering a single task (pre-enriched data).

## Styling

The plugin includes default styles for status dots and priority badges. You can customize appearance in your vault's CSS snippets:

```css
/* Customize status dot colors */
.task-status-dot[data-status="open"] {
    background-color: #your-color;
}

/* Customize priority badge */
.task-priority-badge {
    font-size: 1em;
}
```

## Contributing

Issues and pull requests welcome! This plugin is designed to be simple and focused.

## Acknowledgments

The interactive task list layout was inspired by the TaskNotes plugin's visual design.

## License

MIT License - See LICENSE file for details

## Author

Created by Johnny Chadda for personal use and shared with the Obsidian community.
