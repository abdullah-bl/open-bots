import type { Bot } from './types'

export interface BotTemplate {
  key: string
  name: string
  color: string
  blurb: string
  goal: string
  instructions: string
  starter: string
}

export const TEMPLATES: BotTemplate[] = [
  {
    key: 'researcher',
    name: 'Scout',
    color: '#e0703a',
    blurb: 'Researches a topic on the web and writes a sourced report.',
    goal: 'Research topics thoroughly on the web and write clear, sourced reports.',
    instructions:
      'Search several sources, read the most relevant pages, and cross-check facts. Write the report to a markdown file with a short summary at the top and links to sources.',
    starter: 'Research the current state of WebGPU support across browsers and write report.md.',
  },
  {
    key: 'analyst',
    name: 'Abacus',
    color: '#3b82c4',
    blurb: 'Analyzes CSV and data files with Python and makes charts.',
    goal: 'Analyze data files in the workspace with Python and explain what they show.',
    instructions:
      'Inspect data before analyzing it. Use pandas and matplotlib. Save charts as PNG files and a findings.md summary. Explain results in plain language.',
    starter: 'Make a sample sales.csv with 12 months of data for 3 products, then chart the trends and summarize them.',
  },
  {
    key: 'briefing',
    name: 'Morning',
    color: '#2f9e6a',
    blurb: 'Builds a daily briefing on topics you follow, on a schedule.',
    goal: 'Keep the user up to date on the topics they care about with a short daily briefing.',
    instructions:
      'Ask which topics to follow if you do not know yet, and remember them. Each run, gather the latest news, write briefing-YYYY-MM-DD.md, and notify the user with the top three points.',
    starter: 'Set yourself up to brief me every morning at 08:00 on AI agents and WebAssembly news. Do the first briefing now.',
  },
  {
    key: 'blank',
    name: 'Helper',
    color: '#8b5cf6',
    blurb: 'A general-purpose agent. Give it any goal.',
    goal: '',
    instructions: '',
    starter: '',
  },
]

export function botFromTemplate(t: BotTemplate): Bot {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name: t.name,
    color: t.color,
    goal: t.goal,
    instructions: t.instructions,
    engine: 'auto',
    rules: {},
    memory: [],
    schedules: [],
    createdAt: now,
    updatedAt: now,
  }
}

export const BOT_COLORS = ['#e0703a', '#3b82c4', '#2f9e6a', '#8b5cf6', '#d4469b', '#c99a1a', '#0f9fb0', '#6b7280']
