import { useApp, useInput } from 'ink';

export interface KeymapHandlers {
  onUp: () => void;
  onDown: () => void;
  onEnter: () => void;
  onBack: () => void;
  onToggleFold: () => void;
  onRefresh: () => void;
  onStartFilter: () => void;
  /** Ask Claude for the selected project's next steps (--ai only). */
  onSummarize: () => void;
  /** Filter-mode keystroke handling. */
  onFilterChar: (char: string) => void;
  onFilterBackspace: () => void;
  onFilterCommit: () => void;
  onFilterCancel: () => void;
}

export interface KeymapState {
  filtering: boolean;
  view: 'root' | 'detail';
}

/**
 * The single useInput for the whole app.
 *
 * Ink delivers a key event to every mounted useInput, so having one owner
 * removes any question of which component consumes a keystroke -- particularly
 * while the filter is capturing plain characters that would otherwise be
 * navigation shortcuts.
 */
export function useKeymap(state: KeymapState, handlers: KeymapHandlers): void {
  const { exit } = useApp();

  useInput((input, key) => {
    // Filter mode swallows almost everything: while typing, 'q' is a letter.
    if (state.filtering) {
      if (key.escape) return handlers.onFilterCancel();
      if (key.return) return handlers.onFilterCommit();
      if (key.backspace || key.delete) return handlers.onFilterBackspace();
      if (key.ctrl && input === 'c') return exit();
      // Ignore control sequences; accept printable characters only.
      if (!key.ctrl && !key.meta && input.length > 0 && input >= ' ') {
        handlers.onFilterChar(input);
      }
      return;
    }

    if (key.ctrl && input === 'c') return exit();

    // Arrow keys arrive as key flags with no printable input.
    if (key.upArrow) return handlers.onUp();
    if (key.downArrow) return handlers.onDown();
    if (key.return) return handlers.onEnter();
    if (key.escape) return handlers.onBack();

    // A held key (or a paste) is delivered as ONE multi-character chunk, so
    // 'jjjj' must scroll four rows rather than matching nothing at all.
    for (const char of input) {
      switch (char) {
        case 'q':
          return exit();
        case 'k':
          handlers.onUp();
          break;
        case 'j':
          handlers.onDown();
          break;
        case 'l':
          if (state.view === 'root') handlers.onEnter();
          break;
        case 'h':
          if (state.view === 'detail') handlers.onBack();
          break;
        case ' ':
          handlers.onToggleFold();
          break;
        case 'r':
          handlers.onRefresh();
          break;
        case 'a':
          handlers.onSummarize();
          break;
        case '/':
          handlers.onStartFilter();
          return; // stop consuming: the rest belongs to the filter
        default:
          break;
      }
    }
  });
}
