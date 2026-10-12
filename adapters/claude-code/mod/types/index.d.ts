// The skills concierge would offer for the enhanced draft, as the band shows them.
export type Menu = { skills: string[]; note: string | null }

// An Enhance whose rewrite is in the prompt box: what to rank when that prompt is sent.
export type Pending = { rewrite: string; route: string }

declare module 'claude-code' {
  interface PluginState {
    'concierge-enhancer': {
      isBusy: boolean
      note: string | null
      menu: Menu | null
      pending: Pending | null
      focusKey: string | null
    }
  }
}
